/**
 * Подписи снимков на карточке тура: «Фото: <автор>».
 *
 * Слово владельца 26.10 о снимках гида: «фото используй с подписью». Карта
 * подписей одна на партнёра — `partners.gallery_credits` (адрес снимка →
 * автор), её же читают страницы перевозчика и прокатчика (1319). Тур берёт
 * подпись по адресу своего снимка: кто дал кадры, тот и записал, чьи они.
 *
 * Подпись только из карты и только непустой строкой. Нет записи — подписи нет
 * (null): подписать кадр именем оператора по умолчанию значило бы утверждать
 * авторство, которого никто не записывал. Модуль чистый — его зовёт клиентская
 * карточка, базы он не знает.
 */

function creditsMap(credits: unknown): Record<string, unknown> {
  return credits && typeof credits === 'object' && !Array.isArray(credits)
    ? (credits as Record<string, unknown>)
    : {};
}

/** Подпись к каждому снимку по порядку: «Фото: Автор» или null. */
export function tourPhotoCaptions(photos: readonly string[], credits: unknown): (string | null)[] {
  const map = creditsMap(credits);
  return photos.map((url) => {
    const c = map[url];
    return typeof c === 'string' && c.trim() ? `Фото: ${c.trim()}` : null;
  });
}

/**
 * Одна строка под снимками: «Фото: Автор» или «Фото: Автор, Другой» —
 * авторы без повторов, в порядке снимков. Ни одной подписи — null.
 */
export function tourPhotoCreditLine(captions: readonly (string | null)[]): string | null {
  const authors: string[] = [];
  // Подпись кадра бывает «Автор» и «Автор. Место съёмки». Строка под галереей
  // говорит, ЧЬИ снимки, и одного автора называет один раз: до 20.11 у ID77
  // выходило «Фото: X, X. Вилючинский перевал» (#3487). Место съёмки остаётся
  // в подписи кадра в просмотрщике.
  const sameAuthor = (a: string, b: string) => a === b || b.startsWith(`${a}. `);
  for (const c of captions) {
    if (!c) continue;
    const name = c.slice('Фото: '.length);
    if (authors.some(a => sameAuthor(a, name))) continue;
    const longer = authors.findIndex(a => sameAuthor(name, a));
    if (longer >= 0) authors[longer] = name;
    else authors.push(name);
  }
  return authors.length > 0 ? `Фото: ${authors.join(', ')}` : null;
}
