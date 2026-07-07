/**
 * Расчёт высотного профиля маршрута из GeoJSON LineString (задача L).
 * Чистая функция без сети и БД: используется скриптом
 * scripts/compute-elevation-profile.ts и тестируется на синтетике.
 *
 * Правило НЕ ВРАТЬ: elevation в треке нет — честный no_elevation
 * (внешние elevation-API не дёргаются); геометрия битая — invalid_geometry
 * с причиной. Никаких оценок «на глаз».
 */

export interface ElevationProfile {
  gainM: number;
  lossM: number;
  minM: number;
  maxM: number;
}

export type ProfileResult =
  | { kind: 'ok'; profile: ElevationProfile }
  | { kind: 'no_elevation' }
  | { kind: 'invalid_geometry'; detail: string };

/** Порог шума GPS-высот: подъёмы/спуски меньше 3 м не накапливаются */
const NOISE_THRESHOLD_M = 3;

export function computeElevationProfile(geometry: unknown): ProfileResult {
  if (geometry == null || typeof geometry !== 'object') {
    return { kind: 'invalid_geometry', detail: 'geometry отсутствует или не объект' };
  }

  const g = geometry as { type?: unknown; coordinates?: unknown };
  if (g.type !== 'LineString') {
    return { kind: 'invalid_geometry', detail: `тип ${String(g.type)} вместо LineString` };
  }
  if (!Array.isArray(g.coordinates) || g.coordinates.length < 2) {
    return { kind: 'invalid_geometry', detail: 'меньше двух точек' };
  }

  const elevations: number[] = [];
  for (const point of g.coordinates) {
    if (!Array.isArray(point) || point.length < 2
        || typeof point[0] !== 'number' || typeof point[1] !== 'number'
        || Number.isNaN(point[0]) || Number.isNaN(point[1])) {
      return { kind: 'invalid_geometry', detail: 'точка не [lng, lat, ...числа]' };
    }
    if (point.length >= 3 && typeof point[2] === 'number' && !Number.isNaN(point[2])) {
      elevations.push(point[2]);
    }
  }

  // Высоты должны быть у всего трека, не у случайных точек — иначе профиль
  // будет посчитан по фрагменту и соврёт
  if (elevations.length < g.coordinates.length || elevations.length < 2) {
    return { kind: 'no_elevation' };
  }

  let gain = 0;
  let loss = 0;
  let min = elevations[0];
  let max = elevations[0];

  // Сглаживание: накапливаем перепад от последней «зафиксированной» высоты
  // и учитываем его только когда он превысил порог шума
  let anchor = elevations[0];
  for (let i = 1; i < elevations.length; i++) {
    const e = elevations[i];
    if (e < min) min = e;
    if (e > max) max = e;

    const delta = e - anchor;
    if (Math.abs(delta) >= NOISE_THRESHOLD_M) {
      if (delta > 0) gain += delta;
      else loss += -delta;
      anchor = e;
    }
  }

  return {
    kind: 'ok',
    profile: {
      gainM: Math.round(gain),
      lossM: Math.round(loss),
      minM: Math.round(min),
      maxM: Math.round(max),
    },
  };
}

/** Контролируемый словарь покрытий (постановка L) с русскими лейблами */
export const SURFACE_TYPES: Record<string, string> = {
  paved: 'Асфальт',
  dirt_road: 'Грунтовая дорога',
  trail: 'Тропа',
  prepared_trail: 'Оборудованная тропа',
  off_trail: 'Вне троп',
  coastal: 'Побережье',
  water: 'Вода',
};
