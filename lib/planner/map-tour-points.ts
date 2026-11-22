/**
 * Где на карте стоит день с туром, если движок не знает его точки.
 *
 * Зачем (22.11). Движок ставит день без своей точки в Петропавловск
 * (engine.ts, PKC_COORDS), а у туров каталога координат нет (`coordinates`
 * пуст у всех четырёх туров случая владельца 24.11–04.12). На карте плана
 * дни 1 и 3–11 сливались в один пин «1·3–11», и карта не показывала
 * маршрут вовсе: Паратунка, Мыс Маячный и облёт вулканов стояли в городе.
 *
 * Место тура записано словами — `locationName` («Паратунка, спа-отель
 * «Лагуна»», «Мыс Маячный»). Его сверяем с каталогом мест (/api/routes,
 * kind=place — тот же список, что у /map, у каждого места есть
 * координаты). Это ориентир, а не точка сбора: пин такого дня помечен
 * `approx`, и подпись говорит «место — по описанию тура».
 *
 * Правило сверки — без догадок по смыслу: место подходит, только если ВСЕ
 * его значимые слова (без «вулкан», «мыс», «источники»…) есть в описании
 * тура (по основе слова: «Паратунка» ~ «Паратунская»). Из подходящих —
 * упомянутое раньше всех, затем с большим числом общих слов, затем
 * с коротким названием. Ничего не подошло — день остаётся где был.
 */
import type { PlannerMapDay } from '@/lib/planner/map-markers';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

/** Точка «Петропавловск по умолчанию» движка (engine.ts, PKC_COORDS). */
export const PKC_DEFAULT: readonly [number, number] = [53.01, 158.65];

export interface CatalogPlace {
  title: string;
  lat: number;
  lng: number;
}

/** Слова-виды мест: сами по себе место не называют. */
const GENERIC = new Set([
  'вулкан', 'вулканы', 'мыс', 'озеро', 'озера', 'река', 'реки', 'бухта', 'залив',
  'источник', 'источники', 'горячие', 'термальные', 'водопад', 'водопады', 'зона',
  'отдыха', 'база', 'спа', 'отель', 'природный', 'парк', 'смотровая', 'точка', 'вид',
  'долина', 'перевал', 'гора', 'сопка', 'остров', 'пляж', 'рыболовная', 'камчатская',
  'камчатский', 'камчатка', 'камчатки', 'рыбалка', 'тропа', 'маршрут', 'площадка',
  'лагерь', 'центр', 'район', 'край', 'кордон', 'пещера', 'пещеры', 'лавовые',
]);

const STEM = 6;

/** Основы видов мест: «вулкана» — тоже вид, а не имя. */
const GENERIC_STEMS = new Set([...GENERIC].map(w => w.slice(0, STEM)));

function words(text: string): string[] {
  return text.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я]+/).filter(Boolean);
}

function stem(w: string): string {
  return w.slice(0, STEM);
}

/** Основы значимых слов: от пяти букв, не вид места. */
function keyStems(text: string): string[] {
  return [...new Set(words(text).filter(w => w.length >= 5 && !GENERIC_STEMS.has(stem(w))).map(stem))];
}

/** Основы всех слов от четырёх букв — для разбора равных кандидатов. */
function allStems(text: string): Set<string> {
  return new Set(words(text).filter(w => w.length >= 4).map(w => w.slice(0, 5)));
}

/** Место из каталога по описанию места тура; не подошло ничего — null. */
export function placeForLocation(
  locationName: string | null | undefined,
  places: readonly CatalogPlace[],
): CatalogPlace | null {
  if (!locationName || !locationName.trim()) return null;
  const locWords = words(locationName).map(stem);
  const locAll = allStems(locationName);
  let best: { place: CatalogPlace; pos: number; shared: number; size: number } | null = null;
  for (const place of places) {
    if (!Number.isFinite(place.lat) || !Number.isFinite(place.lng)) continue;
    const keys = keyStems(place.title);
    if (keys.length === 0) continue;
    if (!keys.every(k => locWords.includes(k))) continue;
    const pos = Math.min(...keys.map(k => locWords.indexOf(k)));
    const placeAll = allStems(place.title);
    let shared = 0;
    for (const s of placeAll) if (locAll.has(s)) shared += 1;
    const size = words(place.title).length;
    const better = best === null
      || pos < best.pos
      || (pos === best.pos && shared > best.shared)
      || (pos === best.pos && shared === best.shared && size < best.size);
    if (better) best = { place, pos, shared, size };
  }
  return best?.place ?? null;
}

function isDefaultPoint(c: readonly [number, number]): boolean {
  return Math.abs(c[0] - PKC_DEFAULT[0]) < 0.001 && Math.abs(c[1] - PKC_DEFAULT[1]) < 0.001;
}

/** id тура дня (realTour.tourId) — у дня из движка; нет тура — null. */
export function dayTourId(d: { realTour?: { tourId?: string | number | null } | null }): string | null {
  const id = d.realTour?.tourId;
  return id === undefined || id === null || id === '' ? null : String(id);
}

/**
 * Дни для карты: день с туром, стоящий в точке «по умолчанию», переносится
 * в место тура из каталога и помечается `approx`. Точку, которую движок
 * знает (не по умолчанию), не трогаем. Остальные поля дня — как были.
 */
export function placeDaysOnMap<T extends PlannerMapDay & { realTour?: { tourId?: string | number | null } | null }>(
  days: readonly T[],
  tourLocations: Readonly<Record<string, string>>,
  places: readonly CatalogPlace[],
): T[] {
  const cache = new Map<string, CatalogPlace | null>();
  return days.map(d => {
    const tourId = dayTourId(d);
    if (!tourId || !isDefaultPoint(d.coords)) return d;
    const loc = tourLocations[tourId];
    if (!loc) return d;
    if (!cache.has(loc)) cache.set(loc, placeForLocation(loc, places));
    const place = cache.get(loc);
    if (!place) return d;
    return { ...d, coords: [place.lat, place.lng] as [number, number], approx: true };
  });
}

/** Туры, чьё место нужно узнать: день с туром в точке по умолчанию. */
export function toursToPlace(days: readonly (PlannerMapDay & { realTour?: { tourId?: string | number | null } | null })[]): string[] {
  const ids = new Set<string>();
  for (const d of days) {
    const id = dayTourId(d);
    if (id && isDefaultPoint(d.coords)) ids.add(id);
  }
  return [...ids];
}

export const TOUR_PLACES_TIMEOUT_MS = 6000;
const PLACES_URL = '/api/routes?hasCoords=true&limit=1500&sort=title&kind=place&brief=1';

let placesPromise: Promise<CatalogPlace[]> | null = null;

/** Каталог мест с координатами — один раз на вкладку (тот же список, что у /map). */
export function loadCatalogPlaces(fetchImpl: typeof fetch = fetch): Promise<CatalogPlace[]> {
  if (placesPromise) return placesPromise;
  const run = (async () => {
    const r = await fetchImpl(PLACES_URL, { signal: AbortSignal.timeout(TOUR_PLACES_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`places ${r.status}`);
    const j = await r.json() as { data?: Array<{ title?: unknown; lat?: unknown; lng?: unknown }> };
    return (j.data ?? [])
      .map(x => ({ title: String(x.title ?? ''), lat: Number(x.lat), lng: Number(x.lng) }))
      .filter(x => x.title && Number.isFinite(x.lat) && Number.isFinite(x.lng));
  })();
  placesPromise = run;
  // Отказ не запоминаем: следующий план попробует снова.
  run.catch(() => { placesPromise = null; }); // сам отказ видит и пишет вызывающий
  return run;
}

/** Место тура словами (`locationName` у /api/tours/[id]) по id туров. */
export async function loadTourLocations(
  tourIds: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string>> {
  const pairs = await Promise.all([...new Set(tourIds)].map(async (id) => {
    const r = await fetchImpl(`/api/tours/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(TOUR_PLACES_TIMEOUT_MS) });
    if (!r.ok) return null;
    const j = await r.json() as { success?: boolean; data?: { locationName?: unknown } };
    const loc = j?.success && typeof j.data?.locationName === 'string' ? j.data.locationName.trim() : '';
    return loc ? [id, loc] as const : null;
  }).map(p => p.catch((err: unknown) => {
    // Тур не прочитался — его день остаётся в точке движка, план цел.
    logSwallowedFailure('planner-map', 'tour-location', err);
    return null;
  })));
  return Object.fromEntries(pairs.filter((x): x is readonly [string, string] => x !== null));
}
