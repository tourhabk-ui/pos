/**
 * Кромка-горизонт карточки места (концепт Ω, ревизия владельца 2026-07-19:
 * «сложная геометрия смотрится не так как хотелось — акцентировать по
 * цветам стихий») и чистая гео-математика прибора: пеленг, дистанция,
 * румбы, сезон римскими.
 *
 * Геометрия ОДНА для всех типов — спокойная пологая дуга; различие мест
 * несёт ЦВЕТ стихии (линия, заливка-подсветка, плейсхолдер, прибор).
 * viewBox 0 0 200 46; открытый путь — линия (обводится цветом стихии),
 * замкнутый (closedHorizon) — заливка цветом фона карточки.
 */

/** Единая пологая дуга кромки для всех типов мест */
export const HORIZON = 'M0,30 C55,20 145,20 200,30';

export function horizonPath(): string {
  return HORIZON;
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
