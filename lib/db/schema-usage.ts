/**
 * lib/db/schema-usage.ts
 *
 * Сверка того, что код пишет в базу, с тем, что база объявляет.
 *
 * Повод — живой случай: `INSERT INTO bookings (..., end_date, currency,
 * total_price, ...)` падал на разборе при каждом вызове, потому что `bookings`
 * оказалась VIEW без этих колонок. Бронирование тура существовало в виде
 * маршрута и не существовало как работающая функция; фронт его не звал, и
 * поломка молчала. Тот же приём, применённый ко всей кодовой базе, показал,
 * что случай не единичный.
 *
 * Отдельно нашлось, что миграция 080 строит индекс по `users(telegram_id)` —
 * колонке, которой не объявлял ни один файл схемы. На чистой базе цепочка
 * миграций падает там: репозиторий не мог собрать собственную БД, а на проде
 * это проходило лишь потому, что колонку добавили руками мимо миграций.
 *
 * Разбор нарочно грубый и осторожный: таблицу, чей `CREATE TABLE` не удалось
 * разобрать, НЕ судим — обвинить по неполной схеме хуже, чем промолчать.
 * Чистые функции, никакой сети и БД.
 */

export interface DeclaredSchema {
  /** Таблица → множество объявленных колонок. */
  tables: Map<string, Set<string>>;
  /** Таблицы, чьё CREATE TABLE реально разобрано (только их и судим). */
  created: Set<string>;
  /** VIEW: у них свой сторож (compat-view-writes). */
  views: Set<string>;
}

export interface UndeclaredWrite {
  file: string;
  table: string;
  columns: string[];
}

/** Строит объявленную схему из SQL-файлов (порядок: bootstrap, затем миграции). */
export function parseDeclaredSchema(files: readonly string[]): DeclaredSchema {
  const tables = new Map<string, Set<string>>();
  const created = new Set<string>();
  const views = new Set<string>();

  for (const sql of files) {
    for (const m of sql.matchAll(
      /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_0-9]+)"?/gi,
    )) {
      views.add(m[1].toLowerCase());
    }

    for (const m of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_0-9]+)"?\s*\(([\s\S]*?)\n\s*\);/gi,
    )) {
      const name = m[1].toLowerCase();
      const cols = tables.get(name) ?? new Set<string>();
      for (const raw of m[2].split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('--')) continue;
        if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|EXCLUDE|LIKE)\b/i.test(line)) continue;
        const c = /^"?([a-z_][a-z_0-9]*)"?\s+/i.exec(line);
        if (c) cols.add(c[1].toLowerCase());
      }
      tables.set(name, cols);
      created.add(name);
    }

    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([a-z_0-9]+)"?([\s\S]*?);/gi)) {
      const name = m[1].toLowerCase();
      const cols = tables.get(name) ?? new Set<string>();
      for (const a of m[2].matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z_0-9]*)"?/gi)) {
        cols.add(a[1].toLowerCase());
      }
      for (const r of m[2].matchAll(/RENAME\s+COLUMN\s+"?([a-z_0-9]+)"?\s+TO\s+"?([a-z_0-9]+)"?/gi)) {
        cols.delete(r[1].toLowerCase());
        cols.add(r[2].toLowerCase());
      }
      if (cols.size > 0) tables.set(name, cols);
    }
  }

  return { tables, created, views };
}

/** Находит INSERT'ы, пишущие в необъявленные колонки. */
export function findUndeclaredWrites(
  sources: ReadonlyArray<{ path: string; src: string }>,
  schema: DeclaredSchema,
): UndeclaredWrite[] {
  const out: UndeclaredWrite[] = [];

  for (const { path, src } of sources) {
    for (const m of src.matchAll(/INSERT\s+INTO\s+"?([a-z_0-9]+)"?\s*\(([^)]*)\)/gi)) {
      const table = m[1].toLowerCase();
      if (schema.views.has(table)) continue;      // VIEW — отдельный сторож
      if (!schema.created.has(table)) continue;   // схему не разобрали — не судим
      const declared = schema.tables.get(table);
      if (!declared || declared.size === 0) continue;

      // Список колонок собран в шаблоне — судить по нему нельзя.
      //
      // Захват идёт до ПЕРВОЙ закрывающей скобки, а в динамическом списке она
      // принадлежит не списку, а выражению внутри него:
      //   INSERT INTO operator_settings (user_id, ${updates.map((_, i) => ...)})
      // обрезается на «user_id, ${updates.map((_, i», и `i` — параметр
      // стрелочной функции — попадал в отчёт как несуществующая колонка. Она
      // почти сутки числилась в списке долга как настоящая.
      //
      // Пропустить такой INSERT честнее, чем разобрать наполовину: тот же
      // принцип, по которому не судим таблицу с неразобранным CREATE TABLE.
      if (m[2].includes('${')) continue;

      const columns = m[2]
        .split(',')
        .map((s) => s.replace(/--.*$/gm, '').trim().replace(/^"|"$/g, '').toLowerCase())
        .filter((s) => /^[a-z_][a-z_0-9]*$/.test(s));
      if (columns.length === 0) continue;

      const undeclared = columns.filter((c) => !declared.has(c));
      if (undeclared.length > 0) out.push({ file: path, table, columns: undeclared });
    }
  }

  return out;
}

/**
 * То же для UPDATE. Отдельная функция, а не флаг: у UPDATE другая форма
 * (`SET col = $1, col2 = $2`) и другая цена ошибки — INSERT с несуществующей
 * колонкой ломает создание, UPDATE ломает изменение уже созданного. Так нашлись
 * мёртвая двухфакторная аутентификация и незаписываемая заявка на удаление
 * аккаунта: обе отдавали пятисотку, а не молчали.
 */
export function findUndeclaredUpdates(
  sources: ReadonlyArray<{ path: string; src: string }>,
  schema: DeclaredSchema,
): UndeclaredWrite[] {
  const out: UndeclaredWrite[] = [];

  for (const { path, src } of sources) {
    // Ограничиваем хвост: длинный SET с подзапросами разбирать не беремся —
    // лучше пропустить, чем обвинить по обрывку.
    for (const m of src.matchAll(/UPDATE\s+"?([a-z_0-9]+)"?\s+SET\s+([\s\S]{0,400}?)(?:WHERE|RETURNING|`)/gi)) {
      const table = m[1].toLowerCase();
      if (schema.views.has(table)) continue;
      if (!schema.created.has(table)) continue;
      const declared = schema.tables.get(table);
      if (!declared || declared.size === 0) continue;

      const columns = [...m[2].matchAll(/(?:^|,)\s*"?([a-z_][a-z_0-9]*)"?\s*=/g)].map((x) => x[1].toLowerCase());
      if (columns.length === 0) continue;

      const undeclared = columns.filter((c) => !declared.has(c));
      if (undeclared.length > 0) out.push({ file: path, table, columns: undeclared });
    }
  }

  return out;
}

/** Плоский список `таблица.колонка` — удобен для сравнения со списком долга. */
export function flatten(writes: readonly UndeclaredWrite[]): string[] {
  const set = new Set<string>();
  for (const w of writes) for (const c of w.columns) set.add(`${w.table}.${c}`);
  return [...set].sort();
}
