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
 * Габарит набора точек, км: диагональ ограничивающего прямоугольника
 * (крайний юго-запад → крайний северо-восток). Пустая/одноточечная → 0.
 * Ловит «растянутый» набор, где отдельные прыжки короче порога, но точки
 * разбросаны по большой площади (кейс «Вулкан Авачинский»: пляж → визит-центр
 * → смотровая — каждый скачок < 25 км, а размах ~29 км).
 */
export function boundingSpanKm(coords: Array<[number, number]>): number {
  if (coords.length < 2) return 0;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lat, lng] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return haversineKm(minLat, minLng, maxLat, maxLng);
}

/**
 * Сборник, а не пеший трек. Два сигнала (порог 25 км — реальные пешие
 * сегменты/дневные маршруты короче):
 *   1) хотя бы один прямой сегмент длиннее порога («прыжок» синтетики), ИЛИ
 *   2) весь набор растянут шире порога по габариту (много средних скачков,
 *      суммарно уводящих за десятки км — кейс владельца «Вулкан Авачинский»).
 * В полевом навигаторе такой набор нельзя предлагать как «идти по маршруту» —
 * честнее показать «это подборка мест». Осознанно консервативно: длинный
 * линейный маршрут тоже получит предупреждение, и это безопаснее умолчания.
 */
export function isScatteredCollection(
  coords: Array<[number, number]> | null | undefined,
  thresholdKm = 25,
  spanKm = 25,
): boolean {
  if (!coords || coords.length < 2) return false;
  return maxSegmentKm(coords) > thresholdKm || boundingSpanKm(coords) > spanKm;
}
