/**
 * GET /api/cron/schema-drift — что миграции обещали и чего на базе нет.
 * ТОЛЬКО ЧТЕНИЕ.
 *
 * Отличие от /api/cron/schema-audit: тот считает «не применилось» по именам
 * файлов (файл образа отсутствует в `_migrations`) и по построению слеп к
 * файлу, который записан применённым, но откатился. Здесь сравниваются
 * ДЕЙСТВИЯ: объявленные колонки против information_schema живой базы.
 *
 * Спрашивает прод сам себя — с раннера GitHub в managed PostgreSQL Timeweb
 * не пройти (проверено четырьмя прогонами), а прод ходит в свою базу
 * свободно. Тот же приём, что у schema-audit.
 *
 * Наружу уходят только имена: таблиц, колонок, файлов миграций. Ответ
 * читают в логах Actions — значений из пользовательских данных в нём нет.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { parseDeclarations, diffAgainstActual, type DriftReport } from '@/lib/db/schema-drift';
import { findTypeConflicts } from '@/lib/db/declared-types';
import { unmigratedTables, createdTables, UNAPPLIED_DIR } from '@/lib/db/unmigrated-tables';

export const dynamic = 'force-dynamic';

/**
 * Объявлено миграцией, отсутствует на проде СОЗНАТЕЛЬНО.
 *
 * Заполняется только поимённо и только по решению, у которого есть автор и
 * дата. Догадка о том, что «эта таблица, наверное, не нужна», — это
 * выключение сигнализации, а не настройка: список прощает расхождение
 * навсегда и потому обязан быть коротким и объяснённым.
 *
 * ── Модуль поддержки. Решение владельца 22.08.2026: «поддержка не нужна,
 * внеси в список отсутствующих». Восемь таблиц из `02_support_tables.sql`
 * и `019` описывали тикеты, регламенты ответа и опросы — продукт этого не
 * содержит. Код, который к ним обращается, тем самым мёртв: он может
 * только падать. Снос — отдельная работа, здесь фиксируется лишь то, что
 * отсутствие таблиц ожидаемо.
 *
 * `knowledge_base_articles` в этот список НЕ входит, хотя объявлена тем же
 * файлом `02_support_tables.sql`. Соседство по файлу — не признак родства:
 * её читают база знаний ИИ (`/api/ai/knowledge-base`, счётчик
 * опубликованных статей) и `rag.service`, а не страницы поддержки. Это
 * отдельный вопрос с отдельным ответом, и решать его молчанием нельзя.
 */
const INTENTIONALLY_ABSENT: ReadonlySet<string> = new Set<string>([
  // Модуль поддержки — решение владельца 22.08.2026.
  'tickets',
  'ticket_messages',
  'sla_policies',
  'sla_violations',
  'sla_notifications',
  'surveys',
  'support_agents',
  'feedback',
]);

/**
 * Колонки одной таблицы из текста её `CREATE TABLE`.
 *
 * Разбор грубый и таким задуман: берётся тело скобок и первое слово каждой
 * строки верхнего уровня. Табличные ограничения (`PRIMARY KEY (a, b)`,
 * `UNIQUE`, `FOREIGN KEY`, `CONSTRAINT`, `CHECK`) колонками не являются и
 * отсеиваются по имени. Ошибка разбора здесь безопасна в одну сторону:
 * лишнее имя попадёт в «объявлено, а на проде нет» — то есть в список,
 * который человек и так читает глазами.
 */
function declaredColumnsOf(sql: string, table: string): string[] {
  const re = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["']?${table}["']?\\s*\\(`,
    'i',
  );
  const m = re.exec(sql);
  if (!m) return [];
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < sql.length && depth > 0; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') depth--;
  }
  const body = sql.slice(start, i - 1);

  const NOT_A_COLUMN = new Set([
    'primary', 'unique', 'foreign', 'constraint', 'check', 'exclude', 'like',
  ]);
  const cols: string[] = [];
  let level = 0;
  let line = '';
  for (const ch of body) {
    if (ch === '(') level++;
    if (ch === ')') level--;
    if (ch === ',' && level === 0) { cols.push(line); line = ''; continue; }
    line += ch;
  }
  cols.push(line);

  return cols
    .map((c) => c.replace(/--[^\n]*/g, ' ').trim().split(/\s+/)[0] ?? '')
    .map((c) => c.replace(/^["']|["']$/g, '').toLowerCase())
    .filter((c) => c && /^[a-z0-9_]+$/.test(c) && !NOT_A_COLUMN.has(c));
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const empty: DriftReport = {
    ok: false,
    declared_tables: 0,
    actual_relations: 0,
    missing_tables: [],
    missing_columns: [],
  };

  let files: Array<{ name: string; sql: string }>;
  try {
    const dir = join(process.cwd(), 'migrations');
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf-8') }));
  } catch (err) {
    // Каталога нет в образе — сказать «расхождений нет» здесь было бы враньём.
    return NextResponse.json(
      { ...empty, reason: `каталог migrations/ не прочитан: ${err instanceof Error ? err.message : 'причина неизвестна'}` },
      { status: 500 },
    );
  }

  if (files.length === 0) {
    return NextResponse.json({ ...empty, reason: 'в образе нет ни одного файла миграции' }, { status: 500 });
  }

  try {
    // Представления тоже считаются существующими: таблица, ставшая
    // представлением (agent_route_knowledge, миграция 663), не пропала.
    const { rows } = await pool.query<{ table_name: string; column_name: string; data_type: string; udt_name: string }>(
      `SELECT table_name, column_name, data_type, udt_name
         FROM information_schema.columns
        WHERE table_schema = 'public'`,
    );

    const actual = new Map<string, Set<string>>();
    const actualType = new Map<string, string>();
    for (const r of rows) {
      if (!actual.has(r.table_name)) actual.set(r.table_name, new Set());
      actual.get(r.table_name)!.add(r.column_name);
      // `data_type` у массива — «ARRAY», а сам элемент виден только в
      // `udt_name` (`_text`). Без него TEXT[] и TEXT неотличимы — то есть
      // ровно тот случай, ради которого сверка типов и заводится.
      actualType.set(
        `${r.table_name}.${r.column_name}`,
        r.data_type === 'ARRAY' ? `${r.udt_name.replace(/^_/, '')}[]` : r.data_type,
      );
    }

    const declared = parseDeclarations(files);
    const diff = diffAgainstActual(declared, actual, INTENTIONALLY_ABSENT);

    /**
     * Колонки, объявленные РАЗНЫМИ типами, и что из этого лежит на проде.
     *
     * Перепись пропажи отвечает «колонки нет» и молчаливо подталкивает
     * доиграть исходный DDL. Когда объявлений два, это опасно: 084 объявлял
     * `operator_commissions.booking_id` как UUID, а живая бронь — BIGINT, и
     * слепое доигрывание завело бы колонку, в которую не ложится id.
     *
     * Репозиторий сам по себе на вопрос «какой тип на проде» ответить не
     * может — это честное «не знаю». Здесь оно закрывается фактом из
     * `information_schema`; если колонки нет вовсе, так и написано.
     */
    const conflicts = findTypeConflicts(files)
      .filter((c) => c.base_differs)
      .map((c) => ({
        table: c.table,
        column: c.column,
        declared: c.declarations.map((d) => `${d.normalized} (${d.file})`),
        actual: actualType.get(`${c.table}.${c.column}`) ?? 'колонки нет',
      }));

    /**
     * Таблицы, форму которых репозиторий знает только из ненакатываемых
     * файлов (`lib/database/*.sql`). Миграции о них молчат, поэтому спорить
     * реестру не с кем — и он принимает мёртвое объявление за объявленное.
     *
     * Сверка превращает это «не знаю» в факт по каждой таблице: есть ли она
     * на проде, каких объявленных колонок там нет и какие боевые колонки в
     * объявлении не значатся. Второе не менее важно первого: колонка,
     * существующая на проде и отсутствующая в объявлении, — это то, по чему
     * гард фантомов однажды объявит фантомом живую колонку.
     *
     * Ответ намеренно НЕ выносит вердикта «файл врёт» или «файл прав». За
     * один день 23.08 он оказался и тем, и другим: `partners.contact` он
     * угадал (прод подтвердил отказом 23502), `tour_availability.tour_id` —
     * нет. Вердикт по каждой таблице выносит человек, и выносит он его в одно
     * из двух: миграция, повторяющая боевую форму, либо снос объявления.
     */
    const unapplied = createdTables(UNAPPLIED_DIR);
    const unmigrated = unmigratedTables().map(({ table, declared_in }) => {
      const actualCols = actual.get(table);
      if (!actualCols) {
        return { table, declared_in, on_prod: false as const };
      }
      const declaredCols = declaredColumnsOf(
        readFileSync(join(process.cwd(), UNAPPLIED_DIR, declared_in), 'utf-8'),
        table,
      );
      return {
        table,
        declared_in,
        on_prod: true as const,
        declared_missing_on_prod: declaredCols.filter((c) => !actualCols.has(c)),
        on_prod_not_declared: [...actualCols].filter((c) => !declaredCols.includes(c)).sort(),
      };
    });

    return NextResponse.json({
      ok: true,
      collected_at: new Date().toISOString(),
      migration_files: files.length,
      ...diff,
      drift_total: diff.missing_tables.length + diff.missing_columns.length,
      type_conflicts_total: conflicts.length,
      type_conflicts: conflicts,
      unapplied_files_tables: unapplied.size,
      unmigrated_total: unmigrated.length,
      unmigrated_on_prod: unmigrated.filter((u) => u.on_prod).length,
      unmigrated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'база не ответила';
    console.error('[schema-drift] сверка не выполнена:', message);
    return NextResponse.json({ ...empty, reason: message }, { status: 500 });
  }
}
