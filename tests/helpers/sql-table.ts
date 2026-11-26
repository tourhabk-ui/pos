/**
 * Имя таблицы в запросе так, как его принимает PostgreSQL: `ONLY`, схема,
 * кавычки, любой регистр ключевых слов.
 *
 * Для сторожей-переписей («кто пишет в таблицу», «кто её читает»). Регулярка
 * по голому имени заглавными буквами молчит там, где база запрос принимает:
 * `update only public."tour_pricing_rules"` — тоже запись (ревью безопасности
 * PR #3804, 25.11; оттуда же tests/helpers/repo-code.ts).
 *
 * Чего не видно и что названо: имя таблицы из переменной (`UPDATE ${table}`).
 */

/** Ссылка на таблицу после ключевого слова. */
export function tableRef(table: string): string {
  return String.raw`(?:only\s+)?(?:"?public"?\s*\.\s*)?"?${table}"?(?![\w"])`;
}

const sql = (head: string, table: string, flags: string) => new RegExp(String.raw`\b${head}\s+${tableRef(table)}`, flags);

/** Любая запись: UPDATE, INSERT, MERGE, COPY, DELETE, TRUNCATE. */
export const writesTo = (table: string, flags = 'i') =>
  sql(String.raw`(?:update|insert\s+into|merge\s+into|copy|delete\s+from|truncate(?:\s+table)?)`, table, flags);

/** Вставка строки. */
export const insertsInto = (table: string, flags = 'i') => sql(String.raw`insert\s+into`, table, flags);

/** Правка существующей строки. */
export const updates = (table: string, flags = 'i') => sql('update', table, flags);

/** Чтение: FROM или JOIN. `DELETE FROM` тоже называет таблицу после FROM — и тоже находится. */
export const readsFrom = (table: string, flags = 'i') => sql('(?:from|join)', table, flags);
