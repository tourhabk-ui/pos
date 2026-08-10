/**
 * lib/on-route/approach.ts
 *
 * Где человек относительно тропы и сколько ему на самом деле идти.
 *
 * ── Что не так без этого ───────────────────────────────────────────────────
 *
 * Полевой скриншот владельца 11.08: «до точки 20.3 км по прямой». Человек
 * стоит в Петропавловске, целевая путевая точка — в Авачинской бухте, а трек
 * маршрута уходит на юго-запад. Прямая между человеком и точкой пересекает
 * залив: числа честны буквально («по прямой» так и написано) и бесполезны по
 * существу — идти по ним нельзя, и они не совпадают с нарисованной линией.
 *
 * Разошлись два источника: линия рисуется по `geometry` маршрута, а число
 * считается до путевой точки из `route_waypoints`. Это разные данные, и они
 * не обязаны сходиться — на этом маршруте не сошлись.
 *
 * ── Что тут считается ──────────────────────────────────────────────────────
 *
 * Тропа — ломаная. Человек и цель проецируются НА НЕЁ (ближайшая точка на
 * ближайшем звене), и путь распадается на три честных куска:
 *
 *   подход   — от человека до тропы, по прямой (иначе никак: тропы туда нет);
 *   по тропе — вдоль ломаной между двумя проекциями;
 *   выход    — от тропы до цели, если цель сама лежит в стороне.
 *
 * Ни один из кусков не выдаётся за другой. Сумма — не «расстояние по тропе»,
 * а «сколько всего идти», и подпись обязана это различать: подход и выход —
 * прямые, и на камчатском рельефе прямая может оказаться непроходимой.
 *
 * Проекция считается в плоскости с поправкой на широту. На двадцати
 * километрах ошибка такого приближения — метры; заводить сюда геодезию
 * значит усложнить то, что и так упирается в точность GPS (±29 м на том же
 * скриншоте).
 */

export interface GeoPoint { lat: number; lng: number }

const KM_PER_DEG_LAT = 111.32;

function kmPerDegLng(lat: number): number {
  return KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Расстояние по прямой, км. */
export function straightKm(a: GeoPoint, b: GeoPoint): number {
  const dy = (b.lat - a.lat) * KM_PER_DEG_LAT;
  const dx = (b.lng - a.lng) * kmPerDegLng((a.lat + b.lat) / 2);
  return Math.hypot(dx, dy);
}

export interface TrackProjection {
  /** Точка на тропе, ближайшая к заданной. */
  point: GeoPoint;
  /** Номер звена ломаной (0 — между точками 0 и 1). */
  segment: number;
  /** Доля вдоль звена, 0..1. */
  t: number;
  /** Насколько человек в стороне от тропы, км. */
  offTrackKm: number;
}

/**
 * Ближайшая точка НА ТРОПЕ, а не ближайшая вершина.
 *
 * Разница существенная: вершины ломаной могут стоять через километры, и
 * «ближайшая вершина» уводит вбок от места, где человек реально выйдет на
 * тропу.
 */
export function projectOnTrack(p: GeoPoint, track: GeoPoint[]): TrackProjection | null {
  if (track.length === 0) return null;
  if (track.length === 1) {
    return { point: track[0], segment: 0, t: 0, offTrackKm: straightKm(p, track[0]) };
  }

  const kx = kmPerDegLng(p.lat);
  const toXY = (q: GeoPoint) => ({ x: q.lng * kx, y: q.lat * KM_PER_DEG_LAT });
  const P = toXY(p);

  let best: TrackProjection | null = null;
  for (let i = 0; i < track.length - 1; i++) {
    const A = toXY(track[i]);
    const B = toXY(track[i + 1]);
    const vx = B.x - A.x, vy = B.y - A.y;
    const len2 = vx * vx + vy * vy;
    // Вырожденное звено (две одинаковые вершины) — не делим на ноль.
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((P.x - A.x) * vx + (P.y - A.y) * vy) / len2));
    const point: GeoPoint = {
      lat: track[i].lat + (track[i + 1].lat - track[i].lat) * t,
      lng: track[i].lng + (track[i + 1].lng - track[i].lng) * t,
    };
    const offTrackKm = straightKm(p, point);
    if (!best || offTrackKm < best.offTrackKm) best = { point, segment: i, t, offTrackKm };
  }
  return best;
}

/** Длина ломаной от её начала до проекции, км. */
function distanceFromStart(track: GeoPoint[], pr: TrackProjection): number {
  let sum = 0;
  for (let i = 0; i < pr.segment; i++) sum += straightKm(track[i], track[i + 1]);
  if (pr.segment < track.length - 1) {
    sum += straightKm(track[pr.segment], pr.point);
  }
  return sum;
}

export interface ApproachPlan {
  /** Точка на тропе, куда человек выходит. */
  joinAt: GeoPoint;
  /** От человека до тропы — по прямой. */
  approachKm: number;
  /** Вдоль тропы между проекциями человека и цели. */
  alongTrackKm: number;
  /** От тропы до цели — по прямой; больше нуля, если цель в стороне. */
  exitKm: number;
  /** Всё вместе. Не «по тропе» — см. подписи. */
  totalKm: number;
  /** Цель лежит не на тропе: об этом надо сказать словами. */
  targetOffTrack: boolean;
  /** Человек далеко от тропы: тоже повод сказать. */
  userOffTrack: boolean;
}

/**
 * Порог «человек на тропе».
 *
 * Точность GPS в горах — десятки метров, и требовать нулевого совпадения
 * значит вечно показывать подход в пять метров. Сто метров — расстояние, на
 * котором человек тропу видит.
 */
export const ON_TRACK_TOLERANCE_KM = 0.1;

export function approachPlan(
  user: GeoPoint, target: GeoPoint, track: GeoPoint[],
): ApproachPlan | null {
  if (track.length < 2) return null;

  const up = projectOnTrack(user, track);
  const tp = projectOnTrack(target, track);
  if (!up || !tp) return null;

  const alongTrackKm = Math.abs(distanceFromStart(track, tp) - distanceFromStart(track, up));
  const approachKm = up.offTrackKm;
  const exitKm = tp.offTrackKm;

  return {
    joinAt: up.point,
    approachKm,
    alongTrackKm,
    exitKm,
    totalKm: approachKm + alongTrackKm + exitKm,
    targetOffTrack: exitKm > ON_TRACK_TOLERANCE_KM,
    userOffTrack: approachKm > ON_TRACK_TOLERANCE_KM,
  };
}
