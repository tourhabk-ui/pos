/**
 * Jaccard similarity on normalized Russian/English text tokens.
 * No external deps — fast enough for in-process dedup of small arrays.
 */

const STOP = new Set([
  'в', 'на', 'и', 'с', 'по', 'для', 'от', 'до', 'из', 'что', 'как', 'это',
  'не', 'он', 'она', 'они', 'мы', 'вы', 'я', 'к', 'а', 'но', 'же', 'или',
  'то', 'об', 'у', 'о', 'при', 'за', 'под', 'над', 'без', 'со', 'через',
  'уже', 'ещё', 'его', 'её', 'их', 'нас', 'вас', 'им', 'ней', 'нем', 'был',
  'была', 'было', 'были', 'есть', 'нет', 'также', 'все', 'всё', 'том',
]);

/**
 * Токены строки для сравнения. Экспортируется, чтобы сравнивать одну строку
 * с сотнями сохранённых заголовков, токенизировав каждую ровно один раз:
 * межпрогонный фильтр разведки гоняет десятки свежих заголовков против тысячи
 * запомненных, и повторная токенизация в каждой паре — единственное место, где
 * дешёвая проверка могла бы стать дорогой.
 */
export function tokenizeForSimilarity(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^а-яёa-z0-9\s]/gi, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP.has(w))
  );
}

export function jaccardFromTokens(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

export function jaccardSimilarity(a: string, b: string): number {
  return jaccardFromTokens(tokenizeForSimilarity(a), tokenizeForSimilarity(b));
}

/**
 * Remove near-duplicates from an ordered list.
 * Earlier items (higher relevance) win over later ones.
 * threshold: 0.5 = aggressive, 0.65 = moderate, 0.8 = conservative
 */
export function deduplicateBySimilarity<T>(
  items: T[],
  getText: (item: T) => string,
  threshold = 0.55,
): T[] {
  const kept: T[] = [];
  for (const item of items) {
    const text = getText(item);
    const isDuplicate = kept.some(k => jaccardSimilarity(getText(k), text) >= threshold);
    if (!isDuplicate) kept.push(item);
  }
  return kept;
}
