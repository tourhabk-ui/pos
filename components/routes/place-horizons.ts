/**
 * Расстояние до места для карточки каталога: «N км от Петропавловска» или
 * от геопозиции, если человек её разрешил (useAnchor).
 *
 * До 22.11 здесь жили и кромка-горизонт, пеленг, румбы и сезон римскими —
 * прибор концепта «Живые окна». Карточка стала каталожной («перемудрили»,
 * владелец 22.11), и у них не осталось потребителя (§10.09: объявленное без
 * потребителя удаляется вместе с ним).
 */

export interface GeoPoint { lat: number; lng: number; }

const R_EARTH_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

/** Дистанция по гаверсинусу, округление до целого км */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R_EARTH_KM * Math.asin(Math.sqrt(s)));
}
