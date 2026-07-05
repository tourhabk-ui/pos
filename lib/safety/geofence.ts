/**
 * lib/safety/geofence.ts
 * Ядро геофенсинга: расчёт расстояний + детекция входа в опасную зону.
 * Чистые функции, нет зависимостей, работает офлайн.
 *
 * Принцип безопасности: если погрешность GPS > дистанция до границы зоны,
 * возвращаем 'uncertain' — не говорим «снаружи», когда не уверены.
 */

export type ZoneHazard = 'volcano' | 'thermal' | 'geyser' | 'avalanche' | 'wildlife' | 'tsunami';
export type ZoneLevel  = 'warning' | 'danger' | 'critical';
export type BreachState = 'inside' | 'near' | 'uncertain';

export interface GeofenceZone {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;       // предупредительный радиус в метрах
  hazard: ZoneHazard;
  level: ZoneLevel;
  message: string;
}

export interface GeofenceBreach {
  zone: GeofenceZone;
  state: BreachState;
  distanceM: number;     // от центра зоны, метры
}

/** Формула гаверсинуса. Возвращает расстояние в метрах. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Живой геофенс-алерт («вы приближаетесь к зоне») можно показывать ТОЛЬКО по
 * свежему GPS-фиксу. Устаревшая позиция из кеша (прошлая сессия у источника,
 * а сейчас пользователь за тысячи км) не должна утверждать текущую близость к
 * опасности — это ложная тревога, которая подрывает доверие к настоящим
 * предупреждениям (trust-first: фейковый safety-факт хуже его отсутствия).
 */
export const GEOFENCE_MAX_POSITION_AGE_MS = 3 * 60 * 1_000; // 3 минуты

export function isPositionFreshForGeofence(timestamp: number, now: number = Date.now()): boolean {
  const ageMs = now - timestamp;
  return ageMs >= 0 && ageMs < GEOFENCE_MAX_POSITION_AGE_MS;
}

/**
 * Проверяет, находится ли точка в зоне или рядом с ней.
 * Возвращает null если точка явно снаружи с учётом погрешности GPS.
 */
export function checkZone(
  lat: number,
  lng: number,
  accuracyM: number,
  zone: GeofenceZone,
): GeofenceBreach | null {
  const distM = haversineM(lat, lng, zone.lat, zone.lng);
  const margin = distM - zone.radiusM;

  // Явно внутри
  if (distM <= zone.radiusM) {
    return { zone, state: 'inside', distanceM: distM };
  }

  // Близко: в пределах 50% радиуса зоны снаружи
  const nearThreshold = zone.radiusM * 0.5;
  if (margin <= nearThreshold) {
    // Погрешность GPS больше расстояния до границы → неопределённость
    if (accuracyM >= margin) {
      return { zone, state: 'uncertain', distanceM: distM };
    }
    return { zone, state: 'near', distanceM: distM };
  }

  return null;
}

const LEVEL_PRIORITY: Record<ZoneLevel, number> = { warning: 1, danger: 2, critical: 3 };
const STATE_PRIORITY: Record<BreachState, number> = { near: 1, uncertain: 2, inside: 3 };

/**
 * Проверяет список зон и возвращает наиболее приоритетное нарушение.
 * Приоритет: inside > uncertain > near, затем по уровню опасности, затем по близости.
 */
export function checkBreach(
  lat: number,
  lng: number,
  accuracyM: number,
  zones: GeofenceZone[],
): GeofenceBreach | null {
  const breaches: GeofenceBreach[] = [];

  for (const zone of zones) {
    const breach = checkZone(lat, lng, accuracyM, zone);
    if (breach) breaches.push(breach);
  }

  if (!breaches.length) return null;

  return breaches.sort((a, b) => {
    const stateDiff = STATE_PRIORITY[b.state] - STATE_PRIORITY[a.state];
    if (stateDiff !== 0) return stateDiff;
    const levelDiff = LEVEL_PRIORITY[b.zone.level] - LEVEL_PRIORITY[a.zone.level];
    if (levelDiff !== 0) return levelDiff;
    return a.distanceM - b.distanceM;
  })[0];
}
