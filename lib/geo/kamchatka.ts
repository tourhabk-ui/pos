/**
 * Kamchatka geography constants and utilities.
 * No reverse geocoding — rough region names by bounding box.
 */

export const KAMCHATKA_BBOX = {
  south: 50.0,
  north: 62.0,
  west: 155.0,
  east: 175.0,
} as const;

export const KAMCHATKA_CENTER = { lat: 56.0, lng: 159.0 } as const;

export type GeoMode = 'planning' | 'on-site' | 'unknown';

export type UserLocation = {
  lat: number;
  lng: number;
  accuracy: number; // meters
  timestamp: number; // ms
};

/**
 * Точка человека для текста, уходящего наружу (зарубежная модель, чужой
 * сервис), — сотые градуса, около километра. Совету и прогнозу точнее не
 * нужно, а точная точка говорит, где человек: геопозиция — персональные
 * данные (152-ФЗ, docs/LEGAL.md). Точную координату получают только SOS и
 * контроль выхода — службы, которые по ней ищут.
 *
 * Ревью безопасности 07.11 (PR #3104): чат-спасатель отдавал моделям точку до
 * метра (`toFixed(5)`), контекст Кузьмича — до 11 м с точностью GPS и
 * расстояния до мест в метрах, по которым точка восстанавливается.
 */
export function coarseDegrees(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Та же точка, огрублённая до километра; точность — не лучше километра. */
export function coarseLocation(p: UserLocation): UserLocation {
  return { ...p, lat: coarseDegrees(p.lat), lng: coarseDegrees(p.lng), accuracy: Math.max(p.accuracy || 0, 1000) };
}

/** Огрублённая точка словами: «53.12, 158.65 (около 1 км)». */
export function coarsePointText(lat: number, lng: number): string {
  return `${coarseDegrees(lat).toFixed(2)}, ${coarseDegrees(lng).toFixed(2)} (около 1 км)`;
}

/** Пометка, которую получает текст с огрублёнными координатами. */
export const COARSE_COORDS_NOTE = '[координаты огрублены до ~1 км]';

// Десятичный градус: 2–3 цифры, точка и от трёх знаков (запятая — от четырёх:
// «150,000» — тысячи, а не долгота). Перед числом нет цифры и «цифры с точкой»
// («100.123» в адресе 192.168.100.123) — это проверяет замена: модуль идёт в
// клиентский бандл (GeoContext), а lookbehind роняет его загрузку в Safari
// < 16.4 (сторож client-regex-no-lookbehind).
const DECIMAL_DEGREE = /(-?)(\d{2,3})([.,])(\d{3,})(?![\d])(?!\.\d)/g;
// Градусы-минуты-секунды и градусы с дробными минутами: оставляем минуты
// (около 1,8 км по широте), секунды и доли минуты — точнее километра.
const DMS = /(\d{1,3})\s*°\s*(\d{1,2})\s*['′’]\s*\d{1,2}(?:[.,]\d+)?\s*(?:["″”]|'')/g;
const DEGREE_DECIMAL_MINUTES = /(\d{1,3})\s*°\s*(\d{1,2})[.,]\d+\s*['′’]/g;

/**
 * Координаты, которые человек вписал в текст сам («я на 53.23912, 158.77123»),
 * — до километра, как и точка из полей запроса. Ревью безопасности PR #3127:
 * чат-спасатель огрублял `lat`/`lng`, а та же точка в тексте сообщения уходила
 * зарубежной модели как есть. `redactPII` координаты не режет нарочно (их
 * читает инструмент погоды Кузьмича), поэтому правило отдельное. Если что-то
 * огрублено, к тексту дописывается пометка — модель не примет точку за точную.
 */
export function coarseCoordsInText(text: string): string {
  let changed = false;
  let out = text.replace(DECIMAL_DEGREE, (m, sign: string, int: string, sep: string, frac: string, at: number) => {
    // Хвост длинного числа — не градус: перед ним цифра или «цифра с точкой».
    if (/\d/.test(text[at - 1] ?? '') || (text[at - 1] === '.' && /\d/.test(text[at - 2] ?? ''))) return m;
    const deg = Number(int);
    if (deg < 30 || deg > 180 || (sep === ',' && frac.length < 4)) return m;
    changed = true;
    return `${sign}${coarseDegrees(Number(`${int}.${frac}`)).toFixed(2)}`;
  });
  out = out.replace(DMS, (_m, d: string, min: string) => { changed = true; return `${d}°${min}′`; });
  out = out.replace(DEGREE_DECIMAL_MINUTES, (_m, d: string, min: string) => { changed = true; return `${d}°${min}′`; });
  return changed ? `${out} ${COARSE_COORDS_NOTE}` : out;
}

/**
 * Расстояние от огрублённой точки — километрами, без ложной точности: сама
 * точка гуляет на полкилометра, и «350 м» было бы неправдой.
 */
export function approxDistanceText(km: number): string {
  return km < 1.5 ? 'ближе 2 км' : `около ${Math.round(km)} км`;
}

export function isInKamchatka(lat: number, lng: number): boolean {
  return (
    lat >= KAMCHATKA_BBOX.south &&
    lat <= KAMCHATKA_BBOX.north &&
    lng >= KAMCHATKA_BBOX.west &&
    lng <= KAMCHATKA_BBOX.east
  );
}

export function regionName(lat: number, lng: number): string {
  if (!isInKamchatka(lat, lng)) return 'вне Камчатки';
  // Грубое деление, без reverse geocoding
  if (lat > 58.5) return 'север Камчатки';
  if (lat < 53.5) return 'юг Камчатки';
  if (lng > 161.5) return 'восточное побережье';
  if (lng < 157.5) return 'западное побережье';
  return 'центральная Камчатка';
}

/**
 * Haversine distance in km between two lat/lng points.
 */
export function distanceKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
