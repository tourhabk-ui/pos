/**
 * Пагинация каталога мест и маршрутов для поисковика (аудит vedarai.ru 01.10).
 *
 * Обход сайта по ссылкам дошёл до 826 страниц из 904 при глубине 10: страницы
 * каталога связывала только цепочка «назад / вперёд», и маршрут с 17-й
 * страницы лежал в восемнадцати переходах от главной. А `canonical` у
 * `/routes?page=2` указывал на первую страницу — поисковик выбрасывал
 * вторую и дальше как дубль, и вместе с ней ссылки на её карточки.
 *
 * Отсюда два правила:
 * - номера страниц ссылками — все, пока их не больше `ALL_PAGES_MAX`, иначе
 *   окно вокруг текущей с первой и последней;
 * - у чистой пагинации свой canonical; с фильтром или поиском — на раздел.
 */

/** До скольких страниц показываем номера всех: каталог сейчас 16–17 страниц. */
export const ALL_PAGES_MAX = 20;

export type PageSlot = number | 'gap';

/** Номера страниц для ссылок пагинации. */
export function pageSlots(page: number, pages: number, allMax = ALL_PAGES_MAX): PageSlot[] {
  if (pages <= 1) return [];
  if (pages <= allMax) return Array.from({ length: pages }, (_, i) => i + 1);
  const set = new Set<number>([1, pages]);
  for (let p = page - 2; p <= page + 2; p++) if (p >= 1 && p <= pages) set.add(p);
  const sorted = [...set].sort((a, b) => a - b);
  const out: PageSlot[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push('gap');
    out.push(p);
  });
  return out;
}

/** Номер страницы из `?page=`; мусор и ноль — первая. */
export function parsePage(raw: string): number {
  const n = parseInt(raw || '1', 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Canonical страницы каталога. `base` — раздел (`/routes`, `/places`).
 * Только номер страницы — свой адрес; любой фильтр или поиск — раздел целиком:
 * отфильтрованные выдачи не самостоятельные страницы, а виды той же.
 */
export function catalogCanonical(site: string, base: string, page: number, hasFilters: boolean): string {
  if (hasFilters || page <= 1) return `${site}${base}`;
  return `${site}${base}?page=${page}`;
}
