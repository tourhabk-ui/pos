/**
 * GET /api/cron/db-size-census — сколько занимает база и чем именно.
 * Bearer CRON_SECRET, только чтение, ничего не меняет.
 *
 * ЗАЧЕМ. 08.09 обсуждали, докупать ли ресурсы базе (панель: 1 CPU, 2 ГБ RAM,
 * 20 ГБ NVMe, 790 ₽/мес). Выяснилось, что решать нечем: размер базы не мерил
 * НИКТО — `pg_database_size` и `pg_total_relation_size` не встречались в коде
 * ни разу. Разговор шёл про устройство и риск, а не про «уже жмёт», и
 * покупка делалась бы по ощущению.
 *
 * Риск при этом настоящий: часть таблиц растёт ТОЛЬКО ВВЕРХ и чистки не
 * имеет — `agent_knowledge` (оценка каждого ответа Кузьмича), `agent_effects`,
 * а у `agent_events` и `safety_decision_events` удаление вовсе запрещено
 * триггером, и запрещено намеренно: ценность журнала в полноте. Заполненный
 * диск базы останавливает всё разом — брони, SOS-алерты, ответы Кузьмича, — и
 * чинить придётся под нагрузкой.
 *
 * ЧЕГО ПЕРЕПИСЬ НЕ ЗНАЕТ — и не делает вид, что знает.
 *
 * Размера ДИСКА. Изнутри PostgreSQL квота тома не видна: `pg_database_size`
 * отвечает, сколько занято, и молчит о том, сколько дано. Проценты
 * заполнения здесь были бы выдумкой, поэтому их нет — есть байты, а предел
 * берётся из панели хостинга глазами. По той же причине нет и вердикта
 * «пора/не пора»: его выносит человек, сравнив два числа.
 *
 * Ещё перепись не считает, что «холодное» можно выбросить. Она лишь называет,
 * сколько весит каждая таблица, чтобы решение про выгрузку в S3 (100 ГБ уже
 * оплачены и подключены — lib/storage/s3.ts) принималось по числу.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

/**
 * Таблицы, которые растут только вверх и чистки не имеют.
 *
 * Список закрытый и осознанный: это наблюдение платформы за собой. Ни одна не
 * участвует в брони, оплате или SOS — значит их вес это первое, что стоит
 * рассматривать к выгрузке, и первое, что надо знать до покупки диска.
 */
const JOURNAL_TABLES = [
  'agent_knowledge',
  'agent_events',
  'agent_effects',
  'safety_decision_events',
] as const;

interface TableRow {
  table_name: string;
  total_bytes: string;
  table_bytes: string;
  index_bytes: string;
  live_rows: string;
}

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [{ rows: dbRows }, { rows: tableRows }] = await Promise.all([
      pool.query<{ db_bytes: string; db_name: string }>(
        `SELECT pg_database_size(current_database())::text AS db_bytes,
                current_database() AS db_name`,
      ),
      // Оценка строк — из pg_stat_user_tables (n_live_tup): это ОЦЕНКА
      // планировщика, а не COUNT(*). Точный счёт по всем таблицам стоил бы
      // полного прохода на боевой базе ради диагностики; названо оценкой,
      // чтобы никто не принял её за факт.
      pool.query<TableRow>(
        `SELECT c.relname AS table_name,
                pg_total_relation_size(c.oid)::text        AS total_bytes,
                pg_table_size(c.oid)::text                 AS table_bytes,
                pg_indexes_size(c.oid)::text               AS index_bytes,
                COALESCE(s.n_live_tup, 0)::text            AS live_rows
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
          WHERE c.relkind = 'r'
            AND n.nspname = 'public'
          ORDER BY pg_total_relation_size(c.oid) DESC
          LIMIT 25`,
      ),
    ]);

    const mb = (bytes: string) => Math.round(Number(bytes) / 1024 / 1024 * 10) / 10;

    const tables = tableRows.map((r) => ({
      table: r.table_name,
      total_mb: mb(r.total_bytes),
      data_mb:  mb(r.table_bytes),
      index_mb: mb(r.index_bytes),
      rows_estimate: Number(r.live_rows),
      journal: (JOURNAL_TABLES as readonly string[]).includes(r.table_name),
    }));

    const dbBytes = dbRows[0]?.db_bytes ?? '0';
    const journalMb = tables.filter(t => t.journal).reduce((s, t) => s + t.total_mb, 0);

    // ТЕМП РОСТА журнальных таблиц.
    //
    // Замер 08.09 показал, что из четырёх «растущих» растёт ОДНА:
    // safety_decision_events — 272 МБ на 586 тысяч строк, тогда как три
    // остальные вместе меньше девяти мегабайт. Вес отвечает «сколько
    // сейчас», темп — «сколько будет», и решение о сроке хранения
    // принимается по второму.
    //
    // Запрос ЛИТЕРАЛЬНЫЙ, с именами таблиц в тексте, а не подставленными.
    // Имя таблицы параметром не передаётся, и интерполяция была бы
    // неотличима от конкатенации — того самого, что запрещено в SQL по всему
    // проекту. Список закрытый: новая журнальная таблица вносится сюда руками.
    //
    // Края диапазона берутся индексом, число строк — оценка планировщика;
    // точного COUNT на боевой базе ради диагностики здесь нет.
    //
    // Отдельный try: отказ этого замера НЕ должен ронять перепись веса. Не
    // смог посчитать темп — так и сказано, вес при этом остаётся.
    let growth: Array<Record<string, unknown>> = [];
    let growthNote: string | null = null;
    try {
      const { rows: growthRows } = await pool.query<{ table_name: string; first_at: string | null; last_at: string | null; days: string | null }>(
        `SELECT 'agent_knowledge' AS table_name, MIN(created_at)::text AS first_at, MAX(created_at)::text AS last_at,
                (EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at))) / 86400.0)::text AS days
           FROM agent_knowledge
         UNION ALL
         SELECT 'agent_events', MIN(created_at)::text, MAX(created_at)::text,
                (EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at))) / 86400.0)::text
           FROM agent_events
         UNION ALL
         SELECT 'agent_effects', MIN(created_at)::text, MAX(created_at)::text,
                (EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at))) / 86400.0)::text
           FROM agent_effects
         UNION ALL
         SELECT 'safety_decision_events', MIN(created_at)::text, MAX(created_at)::text,
                (EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at))) / 86400.0)::text
           FROM safety_decision_events`,
      );
      const byName = new Map(tables.map(t => [t.table, t]));
      growth = growthRows.map((g) => {
        const t = byName.get(g.table_name);
        const days = Number(g.days ?? '0');
        // Меньше суток истории — темпа ещё нет. Делить на околоноль и
        // выдавать частное за скорость роста нельзя (§4.0).
        const measurable = days >= 1 && t != null && t.rows_estimate > 0;
        return {
          table: g.table_name,
          first_at: g.first_at,
          last_at:  g.last_at,
          rows_per_day: measurable ? Math.round(t!.rows_estimate / days) : null,
          mb_per_day:   measurable ? Math.round(t!.total_mb / days * 10) / 10 : null,
          note: measurable ? null : 'истории меньше суток либо таблицы нет в срезе — темп не считается',
        };
      });
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
      console.error(`[cron/db-size-census] темп роста не посчитан, SQLSTATE ${code}:`, err);
      growthNote = `темп не посчитан: SQLSTATE ${code}`;
    }

    return NextResponse.json({
      ok: true,
      probe: 'db_size_census_v1',
      database: dbRows[0]?.db_name ?? null,
      total_mb: mb(dbBytes),
      // Предел тома изнутри PostgreSQL не виден: занято знаем, сколько дано —
      // нет. Сравнение с тарифом делает человек, глядя в панель.
      disk_limit_mb: null,
      disk_limit_note: 'квота тома изнутри PostgreSQL не читается — сверить с тарифом в панели хостинга',
      // Сколько весит наблюдение платформы за собой. Это и есть кандидат на
      // выгрузку в S3 — но решение о сроке хранения за владельцем: у двух из
      // четырёх таблиц удаление запрещено триггером намеренно.
      journal_mb: Math.round(journalMb * 10) / 10,
      journal_share: mb(dbBytes) > 0
        ? Math.round(journalMb / mb(dbBytes) * 1000) / 10
        : null,
      tables,
      // Темп роста журналов: «сколько будет», а не «сколько сейчас».
      // Пустой список с заполненным growth_note — это «не смог посчитать»,
      // а не «журналы не растут».
      journal_growth: growth,
      growth_note: growthNote,
      rows_note: 'rows_estimate — оценка планировщика (pg_stat_user_tables.n_live_tup), не COUNT(*)',
      // Ноль таблиц — отказ переписи, а не «база пуста» (§4.0).
      meaningful: tableRows.length > 0,
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[cron/db-size-census] перепись не выполнена, SQLSTATE ${code}:`, err);
    return NextResponse.json(
      { ok: false, probe: 'db_size_census_v1', error: 'перепись не выполнена', sqlstate: code },
      { status: 503 },
    );
  }
}
