/**
 * Силуэты горизонта для карточки места (концепт Ω «Живые окна») и чистая
 * гео-математика прибора: пеленг, дистанция, румбы, сезон римскими.
 *
 * Кромка фото вырубается SVG-путём по типу места: вулкан — конус, горы —
 * пила вершин, озеро — гладь. viewBox 0 0 200 46; открытый путь — линия
 * горизонта (обводится цветом стихии), замкнутый (closedHorizon) — заливка
 * цветом фона карточки поверх нижней кромки фото.
 */

/** Открытые пути кромки (M0,y … L200,y), ломаные 5–13 точек */
export const HORIZONS: Record<string, string> = {
  volcano:    'M0,34 L58,30 L86,10 L100,6 L114,10 L142,30 L200,33',
  mountain:   'M0,32 L28,18 L48,28 L72,10 L92,24 L118,8 L142,26 L166,16 L200,30',
  glacier:    'M0,28 L50,16 L100,12 L150,16 L200,28',
  rock:       'M0,34 L24,14 L34,30 L52,8 L64,28 L84,12 L96,32 L120,16 L134,34 L200,30',
  lake:       'M0,20 L30,14 L52,24 L148,24 L172,16 L200,20',
  river:      'M0,28 L30,24 L60,30 L95,22 L130,30 L165,24 L200,28',
  waterfall:  'M0,16 L60,14 L84,16 L92,34 L120,36 L200,32',
  bay:        'M0,12 L40,22 L80,30 L200,30',
  cape:       'M0,14 L60,20 L120,28 L200,32',
  island:     'M0,30 L60,30 L90,14 L110,14 L140,30 L200,30',
  beach:      'M0,30 L50,26 L110,32 L160,28 L200,31',
  hot_spring: 'M0,32 L36,27 L70,32 Q84,14 100,26 Q114,10 128,24 L160,29 L200,32',
  geyser:     'M0,32 L36,27 L70,32 Q84,14 100,26 Q114,10 128,24 L160,29 L200,32',
  thermal:    'M0,32 L36,27 L70,32 Q84,14 100,26 Q114,10 128,24 L160,29 L200,32',
  forest:     'M0,30 L14,24 L26,30 L40,22 L54,30 L70,25 L84,31 L100,23 L116,30 L134,25 L150,31 L170,26 L200,30',
  museum:     'M0,28 L60,26 L130,29 L200,27',
  historical: 'M0,28 L60,26 L130,29 L200,27',
  settlement: 'M0,28 L60,26 L130,29 L200,27',
  viewpoint:  'M0,28 L60,26 L130,29 L200,27',
  other:      'M0,28 L60,26 L130,29 L200,27',
};

export function horizonPath(locationType: string | null | undefined): string {
  return HORIZONS[locationType ?? 'other'] ?? HORIZONS.other;
}

/** Замкнутый вариант пути — заливка под кромкой цветом фона карточки */
export function closedHorizon(openPath: string): string {
  return `${openPath} L200,46 L0,46 Z`;
}

// ── Гео-математика прибора ────────────────────────────────────────────────

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

/** Начальный пеленг a→b в градусах [0, 360) */
export function bearingDeg(a: GeoPoint, b: GeoPoint): number {
  const dLng = rad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

const RUMBS = ['С', 'ССВ', 'СВ', 'ВСВ', 'В', 'ВЮВ', 'ЮВ', 'ЮЮВ', 'Ю', 'ЮЮЗ', 'ЮЗ', 'ЗЮЗ', 'З', 'ЗСЗ', 'СЗ', 'ССЗ'];

/** 16 румбов: С / ССВ / … / ССЗ */
export function rumb16(deg: number): string {
  return RUMBS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/**
 * Сезон римскими: [7,8,9] → «VII–IX», [12,1,2] → «XII–II» (зимний перенос),
 * [7] → «VII». Невалидные месяцы отбрасываются; пусто → ''.
 */
export function seasonRoman(months: number[] | null | undefined): string {
  const ms = [...new Set((months ?? []).filter((m) => m >= 1 && m <= 12))].sort((x, y) => x - y);
  if (ms.length === 0) return '';
  if (ms.length === 1) return ROMAN[ms[0]];
  // Непрерывный ли диапазон (с возможным переносом через декабрь→январь):
  // ищем стартовый месяц, от которого все идут подряд по кругу
  for (const start of ms) {
    let ok = true;
    for (let i = 0; i < ms.length; i++) {
      if (!ms.includes(((start - 1 + i) % 12) + 1)) { ok = false; break; }
    }
    if (ok) {
      const end = ((start - 1 + ms.length - 1) % 12) + 1;
      return `${ROMAN[start]}–${ROMAN[end]}`;
    }
  }
  return `${ROMAN[ms[0]]}–${ROMAN[ms[ms.length - 1]]}`;
}
