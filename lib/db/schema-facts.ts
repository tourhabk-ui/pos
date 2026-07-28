/**
 * lib/db/schema-facts.ts
 *
 * Факты о боевой схеме — то, что можно узнать ТОЛЬКО спросив саму базу.
 *
 * Понадобилось после дня, в котором форму боевых таблиц выводили из кода:
 * «страница работает, значит колонка есть». Вывод — не наблюдение, и один
 * такой вывод (о форме `notifications`) едва не уехал в прод переписанным
 * сервисом.
 *
 * Спросить базу с раннера GitHub нельзя: managed PostgreSQL Timeweb не пускает
 * внешние адреса. Проверено четырьмя прогонами 10 июля и 28 июля, двумя разными
 * способами разбора строки подключения — везде TCP-таймаут. Зато прод ходит в
 * свою базу свободно, а раннер свободно ходит в прод по HTTPS: на этом стоят
 * все кроны платформы. Поэтому спрашивает прод, а раннер только зовёт.
 *
 * ИЗ БАЗЫ ВЫХОДЯТ ТОЛЬКО МЕТАДАННЫЕ И СЧЁТЧИКИ: имена таблиц, колонок, типов,
 * индексов, имена миграций, количества строк. Ни одного значения из
 * пользовательских данных — ответ уезжает в лог GitHub Actions, и почта или
 * телефон в нём были бы трансграничной передачей ПД.
 */
import { readdirSync } from 'fs';
import { join } from 'path';
import { pool } from '@/lib/db-pool';

/** Таблицы, о форме которых код делает предположения. */
export const AUDITED_TABLES = [
  'users',
  'partners',
  'notifications',
  'chat_sessions',
  'operator_tours',
  'tour_availability',
  'operator_bookings',
  // Добавлены после первого прогона: аудит показал, что `bookings` и `tours` в
  // проде — БАЗОВЫЕ ТАБЛИЦЫ, а не представления, как утверждала миграция 132 и
  // как я весь день считал. Значит нужно знать их настоящие колонки: от этого
  // зависит, была ли правка бронирования тура починкой или регрессией.
  'bookings',
  'tours',
  // Таблицы, которых касаются восемь неприменившихся миграций. Причину отказа
  // можно вывести из формы схемы, не выполняя миграцию на живой базе: 673
  // строит индексы по agent_memory и ai_actions_log, 676 меняет тип колонки в
  // smart_notifications_log, 675 и 685 создают свои таблицы, 779 добавляет slug
  // в places и kamchatka_routes, 670/738 пересобирают view по колонкам
  // kamchatka_routes. Отсутствующая таблица объясняет отказ сразу.
  'kamchatka_routes',
  'places',
  'agent_memory',
  'ai_actions_log',
  'smart_notifications_log',
  'user_place_photos',
  'place_safety_reports',
] as const;

/** Имена, которые в разное время были то таблицей, то представлением. */
export const AUDITED_RELATIONS = [
  'bookings',
  'tours',
  'agent_route_knowledge',
  'v_kamchatka_routes_api',
] as const;

/**
 * Функции, на существование которых опирается код или миграции. `translit_ru_slug`
 * создаёт миграция 779; если функции нет — 779 не доходила даже до бэкфилла.
 */
export const AUDITED_FUNCTIONS = ['translit_ru_slug'] as const;

export interface SchemaFacts {
  /** таблица → ['колонка тип [NOT NULL]', ...]; отсутствие ключа = таблицы нет. */
  columns: Record<string, string[]>;
  /** имя → 'BASE TABLE' | 'VIEW' */
  relations: Record<string, string>;
  migrations: {
    applied: number;
    files: number;
    /** Файлы образа, которых нет в `_migrations`. Считается на проде, поэтому
     *  это именно «не применилось», а не «в образе ещё нет файла». */
    unapplied: string[];
    recent: Array<{ name: string; applied_at: string | null }>;
    /**
     * Настоящий текст ошибки последней попытки — то, ради чего форму схемы
     * приходилось разбирать вручную. Пишет `scripts/migrate-standalone.js` при
     * каждом деплое, чистит при успехе. Пустой массив на старом инстансе
     * означает «таблицы ещё нет», а не «провалов нет».
     */
    failures: Array<{ name: string; error: string; attempts: number; last_failed_at: string | null }>;
  };
  usersIndexes: string[];
  /**
   * PK и уникальные ограничения `places`. Спор о причине отказа миграций
   * 675/685 упирался в вопрос, на который никто не смотрел: можно ли вообще
   * сослаться на `places(id)`. FK требует уникальности колонки-цели; если её
   * нет, дело не в типах.
   */
  placesKeys: Array<{ name: string; type: string; columns: string }>;
  /**
   * Как заполняется `places.id`. Миграция 780 падала на
   * «null value in column "id" violates not-null constraint» — значит DEFAULT
   * либо отсутствует, либо не срабатывает, и та же беда у
   * `lib/services/ingest/idilesom-importer.ts`, который тоже вставляет place
   * без id. Чтобы дать колонке правильное значение, нужно знать её DEFAULT и
   * принятый в данных формат. Идентификатор места — не персональные данные:
   * это вулканы и озёра, не люди.
   */
  placesIdShape: { columnDefault: string | null; samples: string[] };
  /** Колонки представления и объекты, которые от него зависят (миграции 670/738). */
  routeViewColumns: string[];
  routeViewDependents: string[];
  /** null — колонки telegram_id нет, считать нечего. */
  telegramIdDuplicates: number | null;
  counts: Record<string, number>;
  /** Имя функции → есть ли она в схеме public. */
  functions: Record<string, boolean>;
}

export async function collectSchemaFacts(): Promise<SchemaFacts> {
  const { rows: colRows } = await pool.query<{
    table_name: string; column_name: string; data_type: string; is_nullable: string;
  }>(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)
      ORDER BY table_name, ordinal_position`,
    [AUDITED_TABLES as unknown as string[]],
  );

  const columns: Record<string, string[]> = {};
  for (const r of colRows) {
    (columns[r.table_name] ??= []).push(
      `${r.column_name} ${r.data_type}${r.is_nullable === 'NO' ? ' NOT NULL' : ''}`,
    );
  }

  const { rows: relRows } = await pool.query<{ table_name: string; table_type: string }>(
    `SELECT table_name, table_type FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [AUDITED_RELATIONS as unknown as string[]],
  );
  const relations: Record<string, string> = {};
  for (const r of relRows) relations[r.table_name] = r.table_type;

  const { rows: appliedRows } = await pool.query<{ name: string }>('SELECT name FROM _migrations');
  const applied = new Set(appliedRows.map((r) => r.name));

  let files: string[] = [];
  try {
    files = readdirSync(join(process.cwd(), 'migrations')).filter((f) => f.endsWith('.sql'));
  } catch {
    // Каталога нет в образе — тогда про «не применилось» ничего не утверждаем.
  }

  // Таблицы может не быть: её заводит раннер миграций, а он мог ещё не
  // отработать на этом инстансе. Отсутствие — не повод ронять весь аудит.
  let failures: SchemaFacts['migrations']['failures'] = [];
  try {
    const { rows } = await pool.query<{
      name: string; error: string; attempts: number; last_failed_at: Date | null;
    }>(
      `SELECT name, error, attempts, last_failed_at
         FROM _migration_failures ORDER BY name`,
    );
    failures = rows.map((r) => ({
      name: r.name,
      error: r.error,
      attempts: r.attempts,
      last_failed_at: r.last_failed_at ? new Date(r.last_failed_at).toISOString() : null,
    }));
  } catch {
    failures = [];
  }

  const { rows: recentRows } = await pool.query<{ name: string; applied_at: Date | null }>(
    'SELECT name, applied_at FROM _migrations ORDER BY applied_at DESC NULLS LAST LIMIT 10',
  );

  const { rows: idxRows } = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'users' ORDER BY indexname`,
  );

  const { rows: keyRows } = await pool.query<{ name: string; type: string; columns: string }>(
    `SELECT c.conname AS name,
            CASE c.contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'u' THEN 'UNIQUE' ELSE c.contype::text END AS type,
            pg_get_constraintdef(c.oid) AS columns
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND t.relname = 'places' AND c.contype IN ('p', 'u')
      ORDER BY c.conname`,
  );

  const { rows: defRows } = await pool.query<{ column_default: string | null }>(
    `SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'places' AND column_name = 'id'`,
  );
  const { rows: idRows } = await pool.query<{ id: string }>(
    'SELECT id FROM places ORDER BY created_at NULLS LAST LIMIT 3',
  );

  const { rows: viewColRows } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'v_kamchatka_routes_api'
      ORDER BY ordinal_position`,
  );

  // Миграция 738 падает на «cannot drop view because other objects depend on
  // it», хотя её собственный комментарий утверждает, что зависимых нет.
  const { rows: depRows } = await pool.query<{ dependent: string }>(
    `SELECT DISTINCT dependent_view.relname AS dependent
       FROM pg_depend d
       JOIN pg_rewrite r ON r.oid = d.objid
       JOIN pg_class dependent_view ON dependent_view.oid = r.ev_class
       JOIN pg_class source ON source.oid = d.refobjid
      WHERE source.relname = 'v_kamchatka_routes_api'
        AND dependent_view.relname <> 'v_kamchatka_routes_api'
      ORDER BY 1`,
  );

  const hasTelegramId = (columns.users ?? []).some((c) => c.startsWith('telegram_id '));
  let telegramIdDuplicates: number | null = null;
  if (hasTelegramId) {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL
          GROUP BY telegram_id HAVING COUNT(*) > 1) d`,
    );
    telegramIdDuplicates = rows[0]?.n ?? 0;
  }

  const counts: Record<string, number> = {};
  for (const t of ['notifications', 'chat_sessions', 'operator_bookings', 'users', 'bookings', 'tours'] as const) {
    if (!columns[t]) continue;
    // Имя таблицы — из константного списка выше, не из ввода.
    const { rows } = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${t}`);
    counts[t] = rows[0]?.n ?? 0;
  }

  const { rows: fnRows } = await pool.query<{ proname: string }>(
    `SELECT p.proname FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1)`,
    [AUDITED_FUNCTIONS as unknown as string[]],
  );
  const present = new Set(fnRows.map((r) => r.proname));
  const functions: Record<string, boolean> = {};
  for (const name of AUDITED_FUNCTIONS) functions[name] = present.has(name);

  return {
    columns,
    relations,
    functions,
    migrations: {
      applied: applied.size,
      files: files.length,
      unapplied: files.filter((f) => !applied.has(f)).sort(),
      failures,
      recent: recentRows.map((r) => ({
        name: r.name,
        applied_at: r.applied_at ? new Date(r.applied_at).toISOString() : null,
      })),
    },
    usersIndexes: idxRows.map((r) => r.indexname),
    placesKeys: keyRows,
    placesIdShape: {
      columnDefault: defRows[0]?.column_default ?? null,
      samples: idRows.map((r) => r.id),
    },
    routeViewColumns: viewColRows.map((r) => r.column_name),
    routeViewDependents: depRows.map((r) => r.dependent),
    telegramIdDuplicates,
    counts,
  };
}
