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
] as const;

/** Имена, которые в разное время были то таблицей, то представлением. */
export const AUDITED_RELATIONS = ['bookings', 'tours', 'agent_route_knowledge'] as const;

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
  };
  usersIndexes: string[];
  /** null — колонки telegram_id нет, считать нечего. */
  telegramIdDuplicates: number | null;
  counts: Record<string, number>;
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

  const { rows: recentRows } = await pool.query<{ name: string; applied_at: Date | null }>(
    'SELECT name, applied_at FROM _migrations ORDER BY applied_at DESC NULLS LAST LIMIT 10',
  );

  const { rows: idxRows } = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'users' ORDER BY indexname`,
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
  for (const t of ['notifications', 'chat_sessions', 'operator_bookings', 'users'] as const) {
    if (!columns[t]) continue;
    // Имя таблицы — из константного списка выше, не из ввода.
    const { rows } = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${t}`);
    counts[t] = rows[0]?.n ?? 0;
  }

  return {
    columns,
    relations,
    migrations: {
      applied: applied.size,
      files: files.length,
      unapplied: files.filter((f) => !applied.has(f)).sort(),
      recent: recentRows.map((r) => ({
        name: r.name,
        applied_at: r.applied_at ? new Date(r.applied_at).toISOString() : null,
      })),
    },
    usersIndexes: idxRows.map((r) => r.indexname),
    telegramIdDuplicates,
    counts,
  };
}
