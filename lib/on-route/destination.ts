/**
 * lib/on-route/destination.ts — «куда» отдельно от «как» (владелец 27.08).
 *
 * Route-first модель смешивала цель и путь в одну строку списка: выбор
 * «Вулкан Авачинский» на самом деле выбирал ОДНУ из линий к нему, а сама
 * гора нигде не фиксировалась как отдельная сущность. Domain-коррекция
 * владельца: `Destination` — то, куда человек идёт (место или точка),
 * `RouteOption` — один из способов туда попасть. Непроверенная линия —
 * ВАРИАНТ ПУТИ внутри цели, а не сама цель.
 *
 * Этот модуль — минимальный первый шаг («доменное разделение без нового
 * маршрутизатора», формулировка владельца): типы + перегруппировка уже
 * существующего результата поиска (lib/routes/path-choice.groupRoutesByPlace)
 * по НАСТОЯЩЕЙ личности места (places.id/lat/lng), а не по строке текста.
 * Сам поиск, построение пути, клик по карте — вне этого шага.
 */

import { groupRoutesByPlace, type PathCandidate } from '@/lib/routes/path-choice';
import type { CalculatedCarRoute } from '@/lib/on-route/calculated-route';

/**
 * `place` — реальная запись `places` (id, координаты известны).
 * `coordinate` — точка без записи в базе. Этим шагом её создавать негде
 * (клика по карте нет) — тип существует для следующего PR, конструкторов
 * `coordinate`-цели здесь нет.
 */
export type Destination =
  | { kind: 'place'; id: string; title: string; lat: number; lon: number }
  | { kind: 'coordinate'; lat: number; lon: number; title?: string };

export interface RouteOption {
  id: string;
  title: string;
  distanceKm: number | null;
  lineGrade: string | null;
  difficulty: string | null;
  elevationGainM: number | null;
  waypointNames: string[];
  /**
   * Путь, посчитанный автомобильным маршрутизатором между конкретными
   * Origin/Destination (владелец 28.08, продолжение PR 5B-1) — НЕ
   * каталожная запись kamchatka_routes. Заполнен только у синтетического
   * варианта из RouteBuildResult.found; у путей из поиска по месту его нет.
   * `lineGrade` у такого варианта НАМЕРЕННО не проставляется (см.
   * lib/on-route/calculated-route.ts) — третий род линии без места в
   * существующей таксономии, приписать грейд значило бы соврать о
   * происхождении.
   */
  calculated?: CalculatedCarRoute;
}

export interface DestinationOption {
  destination: Destination;
  routeOptions: RouteOption[];
}

export interface DestinationCandidate extends PathCandidate {
  /**
   * Личность путевых точек ПАРАЛЛЕЛЬНО waypointNames — тот же индекс,
   * тот же порядок (см. app/api/routes/search: ARRAY_AGG с одинаковым
   * FILTER/ORDER BY). Без параллельных массивов у совпавшего текстом
   * имени нет ни id, ни координат — только строка.
   */
  waypointIds?: (string | null)[];
  waypointLats?: (number | null)[];
  waypointLngs?: (number | null)[];
}

function toRouteOption(r: DestinationCandidate): RouteOption {
  return {
    id: r.id,
    title: r.title,
    distanceKm: r.distanceKm,
    lineGrade: r.lineGrade ?? null,
    difficulty: r.difficulty ?? null,
    elevationGainM: r.elevationGainM ?? null,
    waypointNames: r.waypointNames ?? [],
  };
}

/**
 * Координата и id места, совпавшего в ЭТОМ маршруте с именем группы.
 * `placeName` — буквально та строка из waypointNames, что groupRoutesByPlace
 * уже нашла (см. её `hit`) — тот же элемент массива, индекс общий для
 * имени/id/координат.
 */
function resolvePlaceAt(
  r: DestinationCandidate,
  placeName: string,
): { id: string; lat: number; lon: number } | null {
  const idx = (r.waypointNames ?? []).findIndex((n) => n === placeName);
  if (idx < 0) return null;
  const id = r.waypointIds?.[idx];
  const lat = r.waypointLats?.[idx];
  const lon = r.waypointLngs?.[idx];
  if (!id || lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { id, lat, lon };
}

export interface DestinationSearchResult {
  destinations: DestinationOption[];
  /**
   * Пути, совпавшие только НАЗВАНИЕМ маршрута — либо без места вовсе,
   * либо место названо текстом, но его id/координаты не разрешились ни у
   * одного маршрута группы. Настоящей цели за ними нет — Destination не
   * выдумывается, они остаются путями без карточки места.
   */
  titleOnly: RouteOption[];
}

export function groupRoutesByDestination<T extends DestinationCandidate>(
  routes: T[],
  query: string,
): DestinationSearchResult {
  const groups = groupRoutesByPlace(routes, query);
  const destinations: DestinationOption[] = [];
  const titleOnly: RouteOption[] = [];

  for (const g of groups) {
    if (g.place === null) {
      titleOnly.push(...g.routes.map(toRouteOption));
      continue;
    }

    let resolved: { id: string; lat: number; lon: number } | null = null;
    for (const r of g.routes) {
      resolved = resolvePlaceAt(r, g.place);
      if (resolved) break;
    }

    if (!resolved) {
      titleOnly.push(...g.routes.map(toRouteOption));
      continue;
    }

    destinations.push({
      destination: { kind: 'place', id: resolved.id, title: g.place, lat: resolved.lat, lon: resolved.lon },
      routeOptions: g.routes.map(toRouteOption),
    });
  }

  return { destinations, titleOnly };
}

/* ─── Место, с карточки которого человек пришёл (24.11) ─────────────────────
 *
 * Место из ссылки «Пройти сюда с компасом и GPS» — прочитанное из базы по
 * `?place=`, а не из адреса: координату цели навигации нельзя брать из
 * строки, которую кто угодно может собрать и разослать с чужой точкой под
 * настоящим именем.
 *
 * Скрин владельца 24.11, «Урочище Аквариум»: карточка места построила путь
 * (пешком 16 ч, на машине 74,6 км), а экран «На маршруте» ответил «Ничего не
 * нашлось». Ссылка несла только имя, экран искал по нему маршруты каталога, а
 * через урочище не проходит ни один. Цель при этом была известна — сама
 * точка места, и путь до точки экран строит тем же build(), что и для
 * булавки на карте.
 */

/** Параметр ссылки с id места: пишет карточка места, читает экран «На маршруте». */
export const TRAIL_PLACE_PARAM = 'place';

/** Ссылка «Пройти сюда с компасом и GPS»: имя для поиска и id места для цели. */
export function trailLinkForPlace(place: { id: string; name: string }): string {
  return `/planning?mode=trail&q=${encodeURIComponent(place.name)}&auto=1`
    + `&${TRAIL_PLACE_PARAM}=${encodeURIComponent(place.id)}`;
}

/** id из ссылки годится только такой формы — остальное в адрес API не идёт. */
export function linkedPlaceIdFrom(raw: string | null): string | null {
  return raw && /^[A-Za-z0-9-]{10,64}$/.test(raw) ? raw : null;
}

export interface LinkedPlace {
  title: string;
  lat: number;
  lon: number;
  /** Строка поиска, с которой место пришло: набрал другое — место ни при чём. */
  query: string;
}

/** Ответ GET /api/places/[id] → место для цели; неполный ответ — null. */
export function linkedPlaceFromApi(json: unknown, query: string): LinkedPlace | null {
  if (typeof json !== 'object' || json === null) return null;
  const data = (json as { success?: unknown; data?: unknown }).success === true
    ? (json as { data?: unknown }).data
    : null;
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const title = typeof d.name === 'string' ? d.name.trim() : '';
  const lat = typeof d.lat === 'number' ? d.lat : NaN;
  const lon = typeof d.lng === 'number' ? d.lng : NaN;
  if (!title || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { title, lat, lon, query: query.trim() };
}

/**
 * Одна и та же запись `places`: выдача поиска несёт `places.id`, карточка —
 * `ark_id`, поэтому сличаются координаты той же строки базы. Допуск — доли
 * метра: это равенство одного числа, прочитанного двумя запросами, а не
 * «рядом».
 */
function samePoint(a: { lat: number; lon: number }, b: { lat: number; lon: number }): boolean {
  return Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6;
}

/**
 * Места выдачи с местом из ссылки первым. Нашлось в выдаче — берётся оно, с
 * его готовыми путями. Нет — место встаёт целью без готовых путей: путь до
 * точки считает build(), а пустой список честно говорит «треков нет».
 * Строка поиска сменилась — выдача как есть.
 */
export function withLinkedPlace(
  destinations: DestinationOption[],
  linked: LinkedPlace | null,
  query: string,
): DestinationOption[] {
  if (!linked || linked.query !== query.trim()) return destinations;
  const hit = destinations.find(d => d.destination.kind === 'place' && samePoint(d.destination, linked));
  if (hit) return [hit, ...destinations.filter(d => d !== hit)];
  return [
    { destination: { kind: 'coordinate', lat: linked.lat, lon: linked.lon, title: linked.title }, routeOptions: [] },
    ...destinations,
  ];
}

/**
 * Цель, которую экран выбирает сам по ссылке с карточки (`auto=1`). Ждёт и
 * ответа поиска, и чтения места: выбрать раньше значило бы поставить целью
 * тёзку из выдачи или голую точку там, где у места есть готовые треки.
 * null — выбирать пока нечего или рано.
 */
export function autoDestination(args: {
  destinations: DestinationOption[];
  linked: LinkedPlace | null;
  linkedPhase: 'none' | 'loading' | 'ok' | 'failed';
  searchDone: boolean;
  query: string;
}): DestinationOption | null {
  if (!args.searchDone || args.linkedPhase === 'loading') return null;
  return withLinkedPlace(args.destinations, args.linked, args.query)[0] ?? null;
}
