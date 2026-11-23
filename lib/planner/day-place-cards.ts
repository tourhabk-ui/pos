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
import { dayTourId, placeForLocation, type CatalogPlace } from '@/lib/planner/map-tour-points';

export interface DayPlaceCard {
  /** Чья карточка: место (страница places) или маршрут (страница routes). */
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
    // Короткий адрес по slug, если он записан (23.11): страница места
    // открывается и по slug, и по id (app/places/[id]).
    href: `/places/${encodeURIComponent(typeof detail.slug === 'string' && /^[a-z0-9][a-z0-9-]{0,80}$/.test(detail.slug) ? detail.slug : id)}`,
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

// ── Выбор карточки для дня — без React и без браузера ─────────────────────
// Один и тот же код у /planner (через fetch) и на сервере (боты MAX/TG,
// lib/planner/day-place-cards-server): что за место у дня, какая карточка,
// подряд одно место — один раз. Источники данных подставляет вызывающий.

/** Что нужно знать о дне, чтобы выбрать ему карточку. */
export interface DayPlaceSource {
  day: number;
  title: string;
  description?: string | null;
  /** День поставлен маршрутом каталога с карты. */
  routeId?: string | null;
  realTour?: { tourId?: string | number | null } | null;
}

/** День → id места каталога: место тура по его `locationName`. */
export function placeIdsForDays(
  days: readonly DayPlaceSource[],
  tourLocations: Readonly<Record<string, string>>,
  places: readonly CatalogPlace[],
): Record<number, string> {
  const out: Record<number, string> = {};
  if (places.length === 0) return out;
  const memo = new Map<string, string | null>();
  for (const d of days) {
    if (d.routeId) continue;
    const tid = dayTourId(d);
    const loc = tid ? tourLocations[tid] : undefined;
    if (!loc) continue;
    if (!memo.has(loc)) memo.set(loc, placeForLocation(loc, places)?.id ?? null);
    const id = memo.get(loc);
    if (id) out[d.day] = id;
  }
  return out;
}

/**
 * Карточки по дням: маршрут с карты — карточка маршрута, день с местом —
 * карточка места (если она прочиталась). Подряд одно и то же место (дни
 * многодневного тура) — карточка только у первого дня.
 */
export function assignDayCards(
  days: readonly DayPlaceSource[],
  placeOfDay: Readonly<Record<number, string>>,
  cardsById: Readonly<Record<string, DayPlaceCard | null | undefined>>,
): Record<number, DayPlaceCard> {
  const out: Record<number, DayPlaceCard> = {};
  let prevKey: string | null = null;
  for (const d of days) {
    let card: DayPlaceCard | null = null;
    if (d.routeId) card = routeCard({ id: d.routeId, title: d.title, description: d.description ?? null });
    else if (placeOfDay[d.day]) card = cardsById[placeOfDay[d.day]] ?? null;
    const key = card ? `${card.kind}:${card.id}` : null;
    if (card && key !== prevKey) out[d.day] = card;
    prevKey = key;
  }
  return out;
}

/** Сколько мест читать на один план — не больше, чем дней с турами бывает. */
export const DAY_CARDS_MAX_PLACES = 10;

/** Откуда брать данные: у клиента — fetch к API, у сервера — база напрямую. */
export interface DayPlaceCardDeps {
  loadCatalogPlaces(): Promise<CatalogPlace[]>;
  loadTourLocations(tourIds: readonly string[]): Promise<Record<string, string>>;
  /** Данные места в форме /api/places/[id] (`data`); нет места — null. */
  loadPlaceDetail(id: string): Promise<Record<string, unknown> | null>;
  /** Сбой источника: карточки нет, план цел; вызывающий пишет в лог. */
  onFailure?(source: string, err: unknown): void;
}

/** Все карточки плана одним вызовом (сервер, боты): сбой любого источника — без карточки, не ошибка. */
export async function buildDayPlaceCards(
  days: readonly DayPlaceSource[],
  deps: DayPlaceCardDeps,
): Promise<Record<number, DayPlaceCard>> {
  const fail = (source: string) => (err: unknown) => { deps.onFailure?.(source, err); return null; };
  const tourIds = [...new Set(days.filter(d => !d.routeId).map(dayTourId).filter((x): x is string => !!x))];
  let placeOfDay: Record<number, string> = {};
  if (tourIds.length > 0) {
    const [places, locs] = await Promise.all([
      deps.loadCatalogPlaces().catch(fail('catalog-places')),
      deps.loadTourLocations(tourIds).catch(fail('tour-locations')),
    ]);
    if (places && locs) placeOfDay = placeIdsForDays(days, locs, places);
  }
  const ids = [...new Set(Object.values(placeOfDay))].slice(0, DAY_CARDS_MAX_PLACES);
  const details = await Promise.all(ids.map(id => deps.loadPlaceDetail(id).catch(fail('place-detail'))));
  const cardsById = Object.fromEntries(ids.map((id, i) => [id, placeCardFromDetail(details[i])]));
  return assignDayCards(days, placeOfDay, cardsById);
}

/** Карточка для сообщения бота: адреса страницы и снимка — полные. */
export function absoluteCard(card: DayPlaceCard, origin = 'https://vedarai.ru'): DayPlaceCard {
  const abs = (u: string) => (u.startsWith('/') && !u.startsWith('//') ? `${origin}${u}` : u);
  return { ...card, href: abs(card.href), photo: card.photo ? { ...card.photo, src: abs(card.photo.src) } : null };
}
