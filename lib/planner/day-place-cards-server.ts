/**
 * Карточки мест у дней плана — на сервере (боты MAX/TG для туристов, письма).
 * Выбор тот же, что у /planner (lib/planner/day-place-cards,
 * buildDayPlaceCards); источники — база напрямую, без HTTP к себе:
 *   • каталог мест — queryCatalog (тот же запрос, что у /map), в памяти 10 мин;
 *   • место тура словами — operator_tours.location_name, только туры витрины;
 *   • данные места — loadPlaceDetail без счёта просмотра.
 * Адреса в карточках — пути сайта; для сообщения — absoluteCard.
 */
import { query } from '@/lib/database';
import { CatalogQuerySchema, queryCatalog } from '@/lib/routes/catalog-query';
import { loadPlaceDetail } from '@/lib/places/place-detail';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import {
  absoluteCard, buildDayPlaceCards, type DayPlaceCard, type DayPlaceCardDeps, type DayPlaceSource,
} from '@/lib/planner/day-place-cards';
import type { CatalogPlace } from '@/lib/planner/map-tour-points';

const PLACES_TTL_MS = 10 * 60 * 1000;
let placesCache: { at: number; places: CatalogPlace[] } | null = null;

async function catalogPlaces(): Promise<CatalogPlace[]> {
  if (placesCache && Date.now() - placesCache.at < PLACES_TTL_MS) return placesCache.places;
  const filters = CatalogQuerySchema.parse({ kind: 'place', hasCoords: 'true', limit: '1500', sort: 'title' });
  const { items } = await queryCatalog(filters);
  const places = items
    .map(it => ({ id: it.id, title: it.title, lat: Number(it.lat), lng: Number(it.lng) }))
    .filter(p => p.title && Number.isFinite(p.lat) && Number.isFinite(p.lng));
  placesCache = { at: Date.now(), places };
  return places;
}

async function tourLocations(ids: readonly string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const r = await query(
    `SELECT t.id::text AS id, t.location_name FROM operator_tours t
      WHERE t.id::text = ANY($1::text[]) AND ${publicTourSql('t')}`,
    [ids],
  );
  const out: Record<string, string> = {};
  for (const row of r.rows as Array<{ id: string; location_name: string | null }>) {
    const loc = (row.location_name ?? '').trim();
    if (loc) out[row.id] = loc;
  }
  return out;
}

async function placeDetail(id: string): Promise<Record<string, unknown> | null> {
  const r = await loadPlaceDetail(id, { countView: false });
  return r.status === 200 && r.body.success && r.body.data ? r.body.data : null;
}

export const serverDayPlaceCardDeps: DayPlaceCardDeps = {
  loadCatalogPlaces: catalogPlaces,
  loadTourLocations: tourLocations,
  loadPlaceDetail: placeDetail,
  onFailure: (source, err) => logSwallowedFailure('planner-day-cards', source, err),
};

/**
 * Карточки дней плана на сервере; сбой источника — день без карточки.
 * `absolute` — полные адреса vedarai.ru (для сообщения в MAX/TG).
 *
 * Зовёт мастер «Спланировать поездку» в ботах MAX/TG (lib/chat/trip-wizard-run):
 * ссылка на место дня в строке дня.
 * Сайт зовёт тот же выбор через buildDayPlaceCards (usePlannerDayCards).
 */
export async function dayPlaceCardsOnServer(
  days: readonly DayPlaceSource[],
  opts: { absolute?: boolean } = {},
): Promise<Record<number, DayPlaceCard>> {
  const cards = await buildDayPlaceCards(days, serverDayPlaceCardDeps);
  if (!opts.absolute) return cards;
  return Object.fromEntries(Object.entries(cards).map(([d, c]) => [d, absoluteCard(c)]));
}
