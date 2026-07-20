/**
 * lib/routes/geometry-compact.ts
 *
 * Детектор «паутины»: у части маршрутов geometry — синтетический LineString,
 * соединяющий вейпоинты прямыми (миграция 168). Для компактного маршрута это
 * честная аппроксимация трека; для сборника «35 мест по всему краю» — паутина
 * прямых через весь регион (полевой скрин 20.07). Такую геометрию нельзя
 * рисовать как трек и предлагать «идти по маршруту».
 *
 * Чистый модуль без зависимостей — используется клиентом планировщика.
 */

const EARTH_R = 6371;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Максимальная длина сегмента полилинии, км. Пустая/одноточечная → 0. */
export function maxSegmentKm(coords: Array<[number, number]>): number {
  let max = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = haversineKm(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    if (d > max) max = d;
  }
  return max;
}

/**
 * Сборник, а не трек: хотя бы один прямой сегмент длиннее порога.
 * Порог 25 км: реальные пешие сегменты короче, а «прыжки» синтетики
 * между районами города/бухтами — сильно длиннее.
 */
export function isScatteredCollection(
  coords: Array<[number, number]> | null | undefined,
  thresholdKm = 25,
): boolean {
  if (!coords || coords.length < 2) return false;
  return maxSegmentKm(coords) > thresholdKm;
}
