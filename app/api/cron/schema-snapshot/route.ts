/**
 * GET /api/cron/schema-snapshot — слепок СХЕМЫ прод-БД (задача #57).
 *
 * Находка сквозного прогона 14.08: master-таблицы (places, kamchatka_routes,
 * leads, sos_events, ...) не создаёт ни одна миграция репозитория — они
 * существуют только на проде. Потеря прод-БД означала бы невозможность
 * восстановить схему из кода. Этот эндпоинт отдаёт DDL живой схемы по
 * секциям — из него собирается baseline-файл в репозитории.
 *
 * ТОЛЬКО схема, никогда данные: SELECT-ы ходят исключительно в pg_catalog
 * (152-ФЗ: ни одной строки пользовательских таблиц). Только чтение.
 * Доступ — CRON_SECRET, как у остальных /api/cron/*.
 *
 * ?section=meta|extensions|enums|sequences|tables|constraints|indexes|views|triggers|functions
 * &offset=0&limit=40 — секции с пагинацией, ответ JSON {section,total,offset,ddl[]}.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';

export const dynamic = 'force-dynamic';

const SECTIONS = new Set([
  'meta', 'extensions', 'enums', 'sequences', 'tables',
  'constraints', 'indexes', 'views', 'triggers', 'functions',
]);

/** Запрос секции: только pg_catalog, только чтение. */
function sectionQuery(section: string): { count: string; page: string } | null {
  switch (section) {
    case 'extensions':
      return {
        count: `SELECT COUNT(*)::int AS n FROM pg_extension WHERE extname <> 'plpgsql'`,
        page: `SELECT 'CREATE EXTENSION IF NOT EXISTS ' || quote_ident(extname) || ';' AS ddl
                 FROM pg_extension WHERE extname <> 'plpgsql'
                ORDER BY extname OFFSET $1 LIMIT $2`,
      };
    case 'enums':
      return {
        count: `SELECT COUNT(DISTINCT t.typname)::int AS n
                  FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
                  JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public'`,
        page: `SELECT 'CREATE TYPE ' || quote_ident(t.typname) || ' AS ENUM (' ||
                      string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) || ');' AS ddl
                 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
                 JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public'
                GROUP BY t.typname ORDER BY t.typname OFFSET $1 LIMIT $2`,
      };
    case 'sequences':
      return {
        count: `SELECT COUNT(*)::int AS n FROM pg_sequences WHERE schemaname = 'public'`,
        page: `SELECT 'CREATE SEQUENCE IF NOT EXISTS ' || quote_ident(sequencename) || ';' AS ddl
                 FROM pg_sequences WHERE schemaname = 'public'
                ORDER BY sequencename OFFSET $1 LIMIT $2`,
      };
    case 'tables':
      return {
        count: `SELECT COUNT(*)::int AS n FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
                 WHERE c.relkind = 'r'`,
        page: `SELECT 'CREATE TABLE IF NOT EXISTS ' || quote_ident(c.relname) || E' (\n' ||
                      string_agg('  ' || quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod)
                        || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
                        || COALESCE(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), ''), E',\n' ORDER BY a.attnum)
                      || E'\n);' AS ddl
                 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
                 JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                 LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
                WHERE c.relkind = 'r'
                GROUP BY c.relname ORDER BY c.relname OFFSET $1 LIMIT $2`,
      };
    case 'constraints':
      return {
        count: `SELECT COUNT(*)::int AS n FROM pg_constraint con
                  JOIN pg_class rel ON rel.oid = con.conrelid
                  JOIN pg_namespace n ON n.oid = rel.relnamespace AND n.nspname = 'public'
                 WHERE con.contype IN ('p','u','f','c') AND rel.relkind = 'r'`,
        // PK и UNIQUE раньше FK: порядок важен при восстановлении.
        page: `SELECT 'ALTER TABLE ' || quote_ident(rel.relname) || ' ADD CONSTRAINT ' ||
                      quote_ident(con.conname) || ' ' || pg_get_constraintdef(con.oid) || ';' AS ddl
                 FROM pg_constraint con
                 JOIN pg_class rel ON rel.oid = con.conrelid
                 JOIN pg_namespace n ON n.oid = rel.relnamespace AND n.nspname = 'public'
                WHERE con.contype IN ('p','u','f','c') AND rel.relkind = 'r'
                ORDER BY CASE con.contype WHEN 'p' THEN 1 WHEN 'u' THEN 2 WHEN 'c' THEN 3 ELSE 4 END,
                         rel.relname, con.conname
               OFFSET $1 LIMIT $2`,
      };
    case 'indexes':
      return {
        count: `SELECT COUNT(*)::int AS n
                  FROM pg_index i
                  JOIN pg_class tc ON tc.oid = i.indrelid
                  JOIN pg_namespace n ON n.oid = tc.relnamespace AND n.nspname = 'public'
                 WHERE NOT EXISTS (SELECT 1 FROM pg_constraint cc WHERE cc.conindid = i.indexrelid)`,
        page: `SELECT pg_get_indexdef(i.indexrelid) || ';' AS ddl
                 FROM pg_index i
                 JOIN pg_class ic ON ic.oid = i.indexrelid
                 JOIN pg_class tc ON tc.oid = i.indrelid
                 JOIN pg_namespace n ON n.oid = tc.relnamespace AND n.nspname = 'public'
                WHERE NOT EXISTS (SELECT 1 FROM pg_constraint cc WHERE cc.conindid = i.indexrelid)
                ORDER BY ic.relname OFFSET $1 LIMIT $2`,
      };
    case 'views':
      return {
        count: `SELECT COUNT(*)::int AS n FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
                 WHERE c.relkind = 'v'`,
        // Порядок по oid — грубый порядок создания: view поверх view обычно моложе.
        page: `SELECT 'CREATE OR REPLACE VIEW ' || quote_ident(c.relname) || E' AS\n' ||
                      pg_get_viewdef(c.oid, true) AS ddl
                 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
                WHERE c.relkind = 'v'
                ORDER BY c.oid OFFSET $1 LIMIT $2`,
      };
    case 'triggers':
      return {
        count: `SELECT COUNT(*)::int AS n FROM pg_trigger t
                  JOIN pg_class c ON c.oid = t.tgrelid
                  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
                 WHERE NOT t.tgisinternal`,
        page: `SELECT pg_get_triggerdef(t.oid, true) || ';' AS ddl
                 FROM pg_trigger t
                 JOIN pg_class c ON c.oid = t.tgrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
                WHERE NOT t.tgisinternal
                ORDER BY c.relname, t.tgname OFFSET $1 LIMIT $2`,
      };
    case 'functions':
      return {
        count: `SELECT COUNT(*)::int AS n FROM pg_proc p
                  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
                 WHERE p.prokind IN ('f','p')
                   AND NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.objid = p.oid AND dep.deptype = 'e')`,
        page: `SELECT pg_get_functiondef(p.oid) || ';' AS ddl
                 FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
                WHERE p.prokind IN ('f','p')
                  AND NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.objid = p.oid AND dep.deptype = 'e')
                ORDER BY p.proname OFFSET $1 LIMIT $2`,
      };
    default:
      return null;
  }
}

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret ?? '', process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = new URL(req.url).searchParams;
  const section = sp.get('section') ?? 'meta';
  const offset = Math.max(0, Number(sp.get('offset') ?? 0) || 0);
  const limit = Math.min(100, Math.max(1, Number(sp.get('limit') ?? 40) || 40));

  if (!SECTIONS.has(section)) {
    return NextResponse.json({ error: 'Неизвестная секция', sections: [...SECTIONS] }, { status: 400 });
  }

  try {
    if (section === 'meta') {
      const [ver, kinds] = await Promise.all([
        pool.query<{ v: string }>('SELECT version() AS v'),
        pool.query<{ relkind: string; n: number }>(
          `SELECT c.relkind, COUNT(*)::int AS n
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r','v','i','S')
            GROUP BY c.relkind`,
        ),
      ]);
      return NextResponse.json({
        section: 'meta',
        server: ver.rows[0].v,
        counts: Object.fromEntries(kinds.rows.map((r) => [r.relkind, r.n])),
        snapshot_note: 'Только схема из pg_catalog, данных не отдаёт. Секции: ' + [...SECTIONS].join(', '),
      });
    }

    const q = sectionQuery(section)!;
    const [total, page] = await Promise.all([
      pool.query<{ n: number }>(q.count),
      pool.query<{ ddl: string }>(q.page, [offset, limit]),
    ]);

    // Индексы делаем идемпотентными на выходе — pg_get_indexdef этого не умеет.
    const ddl = page.rows.map((r) =>
      section === 'indexes'
        ? r.ddl.replace(/^CREATE (UNIQUE )?INDEX /, 'CREATE $1INDEX IF NOT EXISTS ')
        : r.ddl,
    );

    return NextResponse.json({
      section,
      total: total.rows[0].n,
      offset,
      count: ddl.length,
      ddl,
    });
  } catch {
    return NextResponse.json({ error: 'Не удалось снять слепок секции' }, { status: 500 });
  }
}
