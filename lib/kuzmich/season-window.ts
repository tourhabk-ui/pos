/**
 * Окно дат вопроса по календарю Камчатки (UTC+12, без летнего времени).
 *
 * Месяц без года больше не считается совпадением. «Осенью» 24 октября 2026 —
 * это 1 сентября — 30 ноября 2026. Заезд 25 августа — 30 сентября 2027
 * в это окно не попадает и доступным не называется.
 * День считает `kamchatkaToday` (lib/seat-requests/core) — тот же сдвиг,
 * что у справки «СЕГОДНЯ».
 */

import { kamchatkaToday } from '@/lib/seat-requests/core';

export interface CalendarDay {
  y: number;
  m: number;
  d: number;
  iso: string;
}

export interface DateWindow {
  start: string;
  end: string;
  /** «осень 2026», «июль 2027» — год в подписи, чтобы сезоны не слипались. */
  label: string;
}

const GENITIVE = [
  '', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const MONTH_NAME = [
  '', 'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

export function calendarDay(now: Date = new Date()): CalendarDay {
  const iso = kamchatkaToday(now.getTime());
  const [y, m, d] = iso.split('-').map((part) => Number(part));
  return { y, m, d, iso };
}

export function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function lastDay(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function ruDate(iso: string | null | undefined): string | null {
  const parsed = parseIsoDate(iso);
  if (!parsed) return null;
  const [, y, m, d] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parsed) ?? [];
  const month = GENITIVE[Number(m)];
  if (!y || !month || !d) return null;
  return `${Number(d)} ${month} ${y}`;
}

/**
 * «на» и «про» требуют винительный: «на зиму», «на весну».
 * Осень, лето и названия месяцев в этом падеже не меняются.
 * Подпись окна хранит именительный («зима 2026–2027») — падеж ставит фраза.
 */
export function seasonAccusative(label: string): string {
  if (label.startsWith('зима')) return `зиму${label.slice('зима'.length)}`;
  if (label.startsWith('весна')) return `весну${label.slice('весна'.length)}`;
  return label;
}

function seasonTitle(months: number[]): string | null {
  const key = [...months].sort((a, b) => a - b).join(',');
  if (key === '9,10,11') return 'осень';
  if (key === '6,7,8') return 'лето';
  if (key === '3,4,5') return 'весна';
  if (key === '1,2,12') return 'зима';
  if (months.length === 1) return MONTH_NAME[months[0]] ?? null;
  return null;
}

/**
 * Год окна: сезон, где сегодня, или ещё впереди — этот год.
 * Уже прошедший сезон этого года — следующий, не прошлый.
 * Зима склеивается через новый год: в январе это декабрь прошлого года.
 */
export function windowForMonths(months: number[], today: CalendarDay): DateWindow {
  if (months.includes(12) && months.includes(1)) {
    const startYear = today.m <= 2 ? today.y - 1 : today.y;
    const endYear = startYear + 1;
    return {
      start: ymd(startYear, 12, 1),
      end: ymd(endYear, 2, lastDay(endYear, 2)),
      label: `зима ${startYear}–${endYear}`,
    };
  }
  const startM = Math.min(...months);
  const endM = Math.max(...months);
  const year = today.m > endM ? today.y + 1 : today.y;
  const title = seasonTitle(months);
  return {
    start: ymd(year, startM, 1),
    end: ymd(year, endM, lastDay(year, endM)),
    label: title ? `${title} ${year}` : `${year}`,
  };
}

export function parseIsoDate(value: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((value ?? '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function rangesOverlap(a0: string, a1: string, b0: string, b1: string): boolean {
  return a0 <= b1 && b0 <= a1;
}

/** Сезон записан и накрывает календарный день. Пустые даты — не «идёт». */
export function coversDay(start: string | null, end: string | null, day: string): boolean {
  const a = parseIsoDate(start);
  const b = parseIsoDate(end);
  if (!a || !b) return false;
  return a <= day && day <= b;
}

/** Сезон записан и пересекает окно вопроса. Пустые даты — не пересекает. */
export function overlapsWindow(start: string | null, end: string | null, window: DateWindow): boolean {
  const a = parseIsoDate(start);
  const b = parseIsoDate(end);
  if (!a || !b) return false;
  return rangesOverlap(a, b, window.start, window.end);
}
