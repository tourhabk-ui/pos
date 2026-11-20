/**
 * Нечёткое совпадение слова запроса с названием (владелец 21.11: «дигерен»
 * не находил «Дыгерен-Оленгендэ»).
 *
 * Два шага, оба в PostgreSQL, без LLM и внешних сервисов:
 * 1. Нормализация букв, которые путают на слух и на клавиатуре: ё→е, э→е,
 *    ы→и, й→и — и в слове запроса (normRu), и в названии (normSql). «Дигерен»,
 *    «дыгерен», «Оленгендэ» и «оленгенде» совпадают как подстроки.
 * 2. Опечатки — триграммы pg_trgm (расширение в baseline прода):
 *    word_similarity(слово, название) ≥ FUZZY_MIN для слов от 4 букв.
 *    Короче — только подстрока: у двух-трёх букв триграмм слишком мало.
 *
 * Слово уходит параметром $n; SQL — только из литералов.
 */

/** Порог word_similarity: 0,6 — пропущенная или лишняя буква в слове из 6–9; при 0,5 «горелый» находил «Гора …». */
export const FUZZY_MIN = 0.6;

const FROM = 'ёэый';
const TO = 'ееии';

/** Нормализованное слово запроса (нижний регистр, ё/э→е, ы/й→и). */
export function normRu(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase()) {
    const i = FROM.indexOf(ch);
    out += i >= 0 ? TO[i] : ch;
  }
  return out;
}

/** То же в SQL для колонки или выражения. */
export function normSql(expr: string): string {
  return `translate(lower(${expr}), '${FROM}', '${TO}')`;
}

/** Слово $n (уже normRu) входит в выражение подстрокой или похоже по триграммам. */
export function fuzzyMatchSql(expr: string, normParam: string): string {
  const n = normSql(expr);
  return `(strpos(${n}, ${normParam}) > 0 OR (char_length(${normParam}) >= 4 AND word_similarity(${normParam}, ${n}) >= ${FUZZY_MIN}))`;
}
