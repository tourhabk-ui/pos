/**
 * lib/db/schema-coverage.ts
 *
 * Какие таблицы код спрашивает, а репозиторий не объявляет.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * За один день трижды нашлась одна и та же беда: код обращается к колонке,
 * которой нет. `operator_bookings.tour_id` в панели тревог, в сервисе туров и
 * в аналитике оператора; `reviews.tour_id` не того типа; `route_waypoints`
 * объявлена с UUID, а на проде text.
 *
 * Общая причина не в невнимательности. Схема-источник НЕПОЛНА: часть таблиц
 * не создаётся ни миграцией, ни baseline. Разработчик (и я) выводит схему из
 * миграций — и выводит неверно, потому что там её нет. Проверить нечем, и
 * ошибка доживает до прода, где падает молча в проглоченном catch.
 *
 * Модуль считает это ЯВНО: список таблиц, к которым код обращается, минус
 * список объявленных. Разница — то, чего никто не может проверить.
 *
 * ── Почему это не «найти все ошибки» ───────────────────────────────────────
 *
 * Разбор — текстовый, и он честно ограничен. CTE, системные каталоги и
 * функции, возвращающие множества, исключаются по признакам; что-то всё равно
 * попадёт мимо. Поэтому список известных расхождений ЗАМОРОЖЕН: сторож не
 * требует чинить накопленное разом, но не даёт добавить новое. Тот же приём,
 * что у реестра LLM-провайдеров (§8, D2).
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

/** Ключевые слова и служебные имена, которые синтаксически стоят там же, где таблица. */
const NOT_A_TABLE = new Set([
  'select', 'where', 'set', 'values', 'only', 'lateral', 'table', 'as', 'dual',
  'information_schema', 'unnest', 'generate_series', 'jsonb_array_elements',
  'jsonb_array_elements_text', 'json_array_elements', 'json_to_recordset',
  'jsonb_to_recordset', 'regexp_split_to_table', 'string_to_table',
]);

/** Системные каталоги Postgres — они есть всегда и объявлять их негде. */
const SYSTEM_PREFIX = /^pg_/;

/** Объявленные в репозитории таблицы и представления. */
export function declaredTables(root = process.cwd()): Set<string> {
  const out = new Set<string>();
  const files: string[] = [];
  const migDir = join(root, 'migrations');
  if (existsSync(migDir)) {
    for (const f of readdirSync(migDir)) if (f.endsWith('.sql')) files.push(join(migDir, f));
  }
  const baseline = join(root, 'lib/database/baseline/schema-baseline.sql');
  if (existsSync(baseline)) files.push(baseline);

  for (const f of files) {
    const txt = readFileSync(f, 'utf-8');
    const patterns = [
      /CREATE\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)/gi,
      /CREATE\s+OR\s+REPLACE\s+(?:VIEW|MATERIALIZED\s+VIEW)\s+["']?(\w+)/gi,
      /ALTER\s+TABLE\s+\w+\s+RENAME\s+TO\s+(\w+)/gi,
    ];
    for (const re of patterns) {
      for (const m of txt.matchAll(re)) out.add(m[1].toLowerCase());
    }
  }
  return out;
}

/** Имена, объявленные в самом файле как CTE (`WITH x AS`, `, x AS`). */
function cteNames(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/(?:WITH(?:\s+RECURSIVE)?|,)\s+(\w+)\s+AS\s*\(/gi)) out.add(m[1].toLowerCase());
  // `) AS m(col, col)` — псевдоним списка значений.
  for (const m of sql.matchAll(/\)\s*AS\s+(\w+)\s*\(/gi)) out.add(m[1].toLowerCase());
  return out;
}

export interface TableUse {
  table: string;
  files: string[];
}

/** Таблицы, к которым обращается код платформы. */
export function usedTables(root = process.cwd()): Map<string, Set<string>> {
  const listed = execSync(
    "git ls-files 'lib/**/*.ts' 'app/**/*.ts' 'scripts/**/*.ts'",
    { encoding: 'utf-8', cwd: root },
  ).split('\n').filter(Boolean).filter((f) => !f.includes('/tests/'));

  const used = new Map<string, Set<string>>();
  for (const f of listed) {
    const raw = readFileSync(join(root, f), 'utf-8');
    // Комментарии выбрасываются: в них по-русски пишут «FROM выше», «JOIN
    // обеих таблиц», и разбор ловил слова прозы как имена таблиц. Сторож,
    // поднимающий ложную тревогу, перестаёт читаться — это уже записано в
    // самом smoke про падеж в заголовке главной.
    const txt = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .map((l) => {
        const js = l.indexOf('//');
        const sql = l.indexOf('--');
        const at = [js, sql].filter((i) => i >= 0).sort((a, b) => a - b)[0];
        return at === undefined ? l : l.slice(0, at);
      })
      .join('\n');
    const locals = cteNames(txt);
    for (const m of txt.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]{2,})\b/g)) {
      const t = m[1].toLowerCase();
      if (NOT_A_TABLE.has(t) || SYSTEM_PREFIX.test(t) || locals.has(t)) continue;
      const set = used.get(t) ?? new Set<string>();
      set.add(f);
      used.set(t, set);
    }
  }
  return used;
}

/**
 * Таблицы, которые код спрашивает, а репозиторий не объявляет.
 * Отсортированы по числу мест: чем шире используется, тем дороже незнание.
 */
export function undeclaredTables(root = process.cwd()): TableUse[] {
  const declared = declaredTables(root);
  const used = usedTables(root);
  return [...used.entries()]
    .filter(([t]) => !declared.has(t))
    .map(([table, files]) => ({ table, files: [...files].sort() }))
    .sort((a, b) => b.files.length - a.files.length || a.table.localeCompare(b.table));
}
