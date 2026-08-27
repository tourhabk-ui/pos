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
