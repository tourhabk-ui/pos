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
  for (const c of captions) {
    if (!c) continue;
    const name = c.slice('Фото: '.length);
    if (!authors.includes(name)) authors.push(name);
  }
  return authors.length > 0 ? `Фото: ${authors.join(', ')}` : null;
}
