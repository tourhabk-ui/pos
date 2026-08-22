/**
 * lib/field/geo.ts — расстояние между двумя координатами.
 *
 * Вынесено из `track-import.ts` не ради порядка, а потому что модуль импорта
 * треков распаковывает KMZ и для этого зовёт `node:zlib`. Полевая форма —
 * клиентский компонент, и брала она отсюда одну эту функцию, но вместе с ней
 * тянула весь модуль: сборка падала на «Module not found: node:zlib», а с ней
 * падал и деплой. Чистая арифметика в клиентском файле, распаковка — в
 * серверном; граница проходит по тому, что чему нужно.
 */

const R_KM = 6371;

export function haversineKm(
  aLat: number, aLng: number, bLat: number, bLng: number,
): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
