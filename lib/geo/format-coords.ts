/**
 * lib/geo/format-coords.ts — координаты словами для экрана и для передачи.
 *
 * Владелец 05.09: «хочу видеть координаты». До этого дня на экране «На
 * маршруте» числа не показывались нигде — только качество фикса («GPS ±8 м»).
 * А координаты в поле нужны ровно затем, чтобы их ПЕРЕДАТЬ: спасателям по
 * спутниковому телефону, товарищу по рации, в чужой навигатор. Отсюда два
 * формата, оба общепринятые в связи со спасателями:
 *
 *   - десятичные градусы (DD), пять знаков — ~1 м, «53.25891, 158.83107»:
 *     так их принимает любой навигатор и так их проще продиктовать;
 *   - градусы-минуты-секунды (DMS), «53°15′32.1″ с.ш. 158°49′51.9″ в.д.»:
 *     так их записывают на бумажных картах и так их часто просят МЧС.
 *
 * Здесь только форматирование, без ввода-вывода: одна функция на экран,
 * буфер обмена и лист наблюдения, чтобы число в трёх местах было одним числом.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** Десятичные градусы через запятую: «53.25891, 158.83107». */
export function formatDD(p: LatLng, digits = 5): string {
  return `${p.lat.toFixed(digits)}, ${p.lng.toFixed(digits)}`;
}

/** Одна координата в градусы-минуты-секунды с десятой секунды. */
export function toDMS(value: number, positive: string, negative: string): string {
  const hemi = value < 0 ? negative : positive;
  const abs = Math.abs(value);
  let deg = Math.floor(abs);
  let minFloat = (abs - deg) * 60;
  let min = Math.floor(minFloat);
  let sec = Math.round((minFloat - min) * 60 * 10) / 10;
  // Округление секунд до 60.0 переносится в минуты, минут до 60 — в градусы:
  // «15′60.0″» — не число, а опечатка, которую в поле читают как 16′.
  if (sec >= 60) { sec -= 60; min += 1; }
  if (min >= 60) { min -= 60; deg += 1; minFloat = 0; }
  return `${deg}°${String(min).padStart(2, '0')}′${sec.toFixed(1).padStart(4, '0')}″ ${hemi}`;
}

/** Градусы-минуты-секунды с полушариями по-русски: «53°15′32.1″ с.ш. 158°49′51.9″ в.д.». */
export function formatDMS(p: LatLng): string {
  return `${toDMS(p.lat, 'с.ш.', 'ю.ш.')} ${toDMS(p.lng, 'в.д.', 'з.д.')}`;
}

export type CoordFormat = 'dd' | 'dms';

export function formatCoords(p: LatLng, format: CoordFormat): string {
  return format === 'dms' ? formatDMS(p) : formatDD(p);
}

/**
 * Расстояние между двумя точками, метры (сфера, гаверсинус). Хватает, чтобы
 * решить «центр карты — это то же место, где я стою, или человек её сдвинул».
 */
export function distanceM(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
