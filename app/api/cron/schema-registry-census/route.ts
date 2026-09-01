/**
 * GET /api/cron/schema-registry-census — что на проде стоит за списком #1304.
 *
 * Только чтение: ни один запрос здесь не пишет и не мутирует данные.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Двадцать восемь таблиц числятся «вне реестра схемы», и это признание
 * незнания, а не диагноз. Разбор 31.08 показал, что за одним пунктом стоят
 * РАЗНЫЕ беды:
 *
 *   `transfer_bookings` — таблицы на проде нет вовсе (42P01 от Watchdog),
 *                         значит пятнадцать файлов, которые её читают, мертвы;
 *   `operators`         — её читают 73 файла, кабинет оператора работает,
 *                         значит она почти наверняка ЕСТЬ, просто заведена
 *                         мимо миграций.
 *
 * «Почти наверняка» — не факт, и остальные двадцать шесть пунктов вообще
 * неизвестны. Способ закрытия у состояний разный (удаление кода против захвата
 * DDL), поэтому смешивать их — значит обречь следующего читающего повторить
 * весь разбор.
 *
 * Роут отвечает на один вопрос: ЧТО НА ПРОДЕ. Сравнение с мёртвыми файлами
 * `lib/database/*_schema.sql` он не делает намеренно — для этого нужны
 * исходники, которых в standalone-бандле нет. Сверку делает тот, у кого есть и
 * ответ роута, и чекаут: воркфлоу, тем же разделением, что routes-audit и
 * census-verdict.ts.
 *
 * ── Почему не считаем строки во всех таблицах разом ────────────────────────
 *
 * `count(*)` по тридцати таблицам — тридцать сканирований. Роут ручной,
 * зовётся редко, но и лишнего делать незачем: точный счёт нужен только чтобы
 * отличить «пустую схему» от живой, и для этого хватает существования хотя бы
 * одной строки. Спрашиваем EXISTS, а не COUNT.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import {
  UNDECLARED_TABLES,
  type RegistryCensusRow,
  type RegistryState,
} from '@/lib/db/undeclared-registry';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Одна поездка за состоянием всех пунктов сразу.
 *
 * Идентификатор таблицы подставляет САМ Postgres через `format('%I')` внутри
 * `query_to_xml`: клиентская конкатенация имени в SQL запрещена (CLAUDE.md),
 * и то, что имя приходит из замороженного списка, запрет не снимает —
 * правило про SQL не имеет исключений «когда источник надёжный».
 *
 * Схема тоже идёт через `%I`, а не литералом `public.`: разбор
 * `lib/db/schema-coverage.ts` читает слово после FROM как имя таблицы и на
 * литерале завёл несуществующую таблицу `public`. Экранировать и схему
 * правильнее по существу, а не только ради сторожа — но сторож здесь был прав.
 *
 * Живость спрашивается подзапросом с LIMIT 1, а не count(*): отличить пустую
 * схему от живой можно одной строкой, полный скан тридцати таблиц ради того
 * же ответа не нужен.
 */
async function inspectAll(): Promise<Map<string, { alive: boolean }>> {
  const { rows } = await pool.query<{ table_name: string; any_row: string | null }>(
    `SELECT t.table_name,
            (xpath(
               '/row/n/text()',
               query_to_xml(
                 format('SELECT count(*) AS n FROM (SELECT 1 FROM %I.%I LIMIT 1) s', t.table_schema, t.table_name),
                 false, true, ''
               )
             ))[1]::text AS any_row
       FROM information_schema.tables t
      WHERE t.table_schema = 'public'
        AND t.table_name = ANY($1::text[])`,
    [[...UNDECLARED_TABLES]],
  );
  return new Map(rows.map((r) => [r.table_name, { alive: (r.any_row ?? '0') !== '0' }]));
}

/** Колонки всех присутствующих пунктов — материал для захвата DDL. */
async function columnsAll(): Promise<Map<string, RegistryCensusRow['columns']>> {
  const { rows } = await pool.query<{
    table_name: string; column_name: string; data_type: string; is_nullable: string;
  }>(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position`,
    [[...UNDECLARED_TABLES]],
  );
  const out = new Map<string, RegistryCensusRow['columns']>();
  for (const r of rows) {
    const list = out.get(r.table_name) ?? [];
    list.push({ name: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES' });
    out.set(r.table_name, list);
  }
  return out;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  // Отказ любого из двух запросов делает НЕИЗВЕСТНЫМ весь список, а не пустым:
  // «не смогли спросить» не равно «ничего нет» (§4.0).
  let live: Map<string, { alive: boolean }>;
  let cols: Map<string, RegistryCensusRow['columns']>;
  try {
    [live, cols] = await Promise.all([inspectAll(), columnsAll()]);
  } catch (err) {
    const e = err as { message?: string; code?: string };
    const reason = `${e.code ? `[${e.code}] ` : ''}${e.message ?? String(err)}`;
    return NextResponse.json({
      success: false,
      contract_version: 1,
      checked_at: new Date().toISOString(),
      verdict: `НЕ СМОГЛИ ПРОВЕРИТЬ: запрос к базе не выполнился (${reason}). Это не «таблиц нет».`,
      counts: { total: UNDECLARED_TABLES.length, absent: 0, present_empty: 0, present_with_rows: 0, unknown: UNDECLARED_TABLES.length },
      tables: UNDECLARED_TABLES.map((t) => ({ table: t, state: 'unknown' as const, rows: null, columns: [], reason })),
    });
  }

  const rows: RegistryCensusRow[] = UNDECLARED_TABLES.map((t) => {
    const l = live.get(t);
    if (!l) return { table: t, state: 'absent' as const, rows: null, columns: [] };
    return {
      table: t,
      state: (l.alive ? 'present_with_rows' : 'present_empty') as RegistryState,
      rows: null,
      columns: cols.get(t) ?? [],
    };
  });

  const by = (s: RegistryState) => rows.filter((r) => r.state === s).map((r) => r.table);
  const absent = by('absent');
  const empty = by('present_empty');
  const alive = by('present_with_rows');
  const unknown = by('unknown');

  // Вердикт словами: читающему нужен следующий шаг, а не только раскладка.
  const verdict =
    `Пунктов ${rows.length}: нет на проде ${absent.length}, ` +
    `есть и пусты ${empty.length}, есть с данными ${alive.length}` +
    (unknown.length
      ? `, НЕ СМОГЛИ СПРОСИТЬ ${unknown.length} — это не «нет», см. reason у каждого.`
      : '. Спросить удалось про все.') +
    (absent.length
      ? ` Мёртвый код (таблицы нет): ${absent.join(', ')}.`
      : '') +
    (alive.length
      ? ` Схема вне репозитория (есть данные, DDL не в миграциях): ${alive.join(', ')}.`
      : '');

  return NextResponse.json({
    success: true,
    /**
     * 1 — исходная форма: состояние и колонки по каждому пункту списка.
     * Поднимать при любом изменении формы, от которой зависит читающий
     * (воркфлоу ждёт объявленную версию — см. safety-ledger-check).
     */
    contract_version: 1,
    checked_at: new Date().toISOString(),
    verdict,
    counts: {
      total: rows.length,
      absent: absent.length,
      present_empty: empty.length,
      present_with_rows: alive.length,
      unknown: unknown.length,
    },
    tables: rows,
  });
}
