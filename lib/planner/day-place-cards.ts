/**
 * Карточка места у дня плана (22.11, владелец: «если мы будем давать ссылку
 * с маленькой фоткой места и маршрута и коротким описанием — будет
 * интереснее»).
 *
 * Только наши данные:
 *   • день с туром — место тура из каталога мест (lib/planner/map-tour-points:
 *     `locationName` тура ↔ место /map), данные — /api/places/[id]?view=0;
 *   • день, поставленный маршрутом с карты (`routeId`), — маршрут каталога
 *     (/plans, /routes/[id]) с его названием и описанием.
 *
 * Фото — только кадр с подписью автора (`photoCredits` места: адрес кадра →
 * автор). Кадра с автором нет — карточка без фото, ничего не подставляем.
 * Кадры места уже прошли правила показа на странице места (род снимка,
 * согласие партнёра — lib/places/place-detail); здесь берётся тот же набор.
 * Миниатюра героя — уменьшенная копия (`?size=card`), не полный кадр.
 */

export interface DayPlaceCard {
  /** Чья карточка: место (/places/id) или маршрут (/routes/id). */
  kind: 'place' | 'route';
  id: string;
  title: string;
  /** 1–2 строки описания; нет — пусто. */
  text: string;
  href: string;
  photo: { src: string; author: string } | null;
}

const TEXT_MAX = 180;

/** Описание до двух строк: первое предложение или обрезка по слову. */
export function shortText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.length <= TEXT_MAX) return t;
  const cut = t.slice(0, TEXT_MAX);
  const dot = cut.lastIndexOf('. ');
  if (dot >= 60) return cut.slice(0, dot + 1);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:—-]+$/, '')}…`;
}

/** Свой адрес кадра (а не чужая ссылка): только /api/images/… */
function ownImage(src: string): boolean {
  return src.startsWith('/api/images/') && !src.startsWith('//');
}

/** Миниатюра: у героя места есть уменьшенная копия `?size=card`. */
export function thumbSrc(src: string): string {
  if (!src.startsWith('/api/images/route/')) return src;
  return src.includes('?') ? `${src}&size=card` : `${src}?size=card`;
}

/** Первый кадр места с подписью автора; нет — null. */
export function creditedPlacePhoto(detail: { images?: unknown; photoCredits?: unknown }): { src: string; author: string } | null {
  const images = Array.isArray(detail.images) ? detail.images : [];
  const credits = detail.photoCredits && typeof detail.photoCredits === 'object'
    ? detail.photoCredits as Record<string, unknown> : {};
  for (const src of images) {
    if (typeof src !== 'string' || !ownImage(src)) continue;
    const author = credits[src];
    if (typeof author === 'string' && author.trim()) return { src: thumbSrc(src), author: author.trim() };
  }
  return null;
}

/** Карточка места из ответа /api/places/[id]; без названия — null. */
export function placeCardFromDetail(detail: Record<string, unknown> | null | undefined): DayPlaceCard | null {
  if (!detail) return null;
  const id = typeof detail.id === 'string' ? detail.id : null;
  const title = typeof detail.name === 'string' ? detail.name.trim() : '';
  if (!id || !title) return null;
  const withdrawn = detail.descriptionWithdrawn === true;
  const text = withdrawn ? shortText(detail.essence) : (shortText(detail.description) || shortText(detail.essence));
  return {
    kind: 'place',
    id,
    title,
    text,
    href: `/places/${encodeURIComponent(id)}`,
    photo: creditedPlacePhoto(detail),
  };
}

/** Карточка маршрута каталога (день с карты): без кадра с автором — без фото. */
export function routeCard(route: { id: string; title: string; description: string | null }): DayPlaceCard {
  return {
    kind: 'route',
    id: route.id,
    title: route.title,
    text: shortText(route.description),
    href: `/routes/${encodeURIComponent(route.id)}`,
    photo: null,
  };
}
