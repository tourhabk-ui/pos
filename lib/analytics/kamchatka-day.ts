/**
 * lib/analytics/kamchatka-day.ts — сутки по Камчатке. Чистые функции, без БД и
 * без сети: их читает и сервер (воронка за окно), и клиентский экран.
 *
 * «Сегодня» владельца — камчатское сегодня: UTC+12 без перехода на летнее
 * время (отменён в 2011), поэтому смещение постоянное. База и сервер живут в
 * других поясах (сессия БД — МСК, Node — UTC), и суточная граница по
 * `CURRENT_DATE` делила бы день человека на два: вечерние просмотры
 * попадали бы в «завтра».
 */

/** Камчатка: UTC+12, летнего времени нет с 2011 года. */
export const KAMCHATKA_UTC_OFFSET_HOURS = 12;
export const KAMCHATKA_TIMEZONE_LABEL = 'Asia/Kamchatka';

const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
const OFFSET_MS = KAMCHATKA_UTC_OFFSET_HOURS * HOUR_MS;

/** YYYY-MM-DD камчатской даты для момента `now`. */
export function kamchatkaDate(now: Date): string {
  return new Date(now.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** Камчатские сутки, в которых лежит `now`: дата и полуоткрытый интервал [start, end). */
export function kamchatkaDayBounds(now: Date = new Date()): { day: string; start: Date; end: Date } {
  const day = kamchatkaDate(now);
  return {
    day,
    start: kamchatkaDayStart(day),
    end: kamchatkaDayStart(shiftDate(day, 1)),
  };
}

/** Момент (UTC), с которого начинаются камчатские сутки `date`. */
export function kamchatkaDayStart(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - OFFSET_MS);
}

/** Дата, сдвинутая на `delta` суток (без часовых поясов — календарная арифметика). */
export function shiftDate(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Настоящая календарная дата: 2026-02-30 и 2026-13-01 не проходят и не переносятся. */
export function isRealDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  const back = new Date(Date.UTC(y, m - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

/**
 * Необязательная дата YYYY-MM-DD.
 *
 * Пустая строка — поля не было: вызывающий вправе взять камчатское сегодня.
 * Явный мусор и несуществующий день — отказ, без подстановки другой даты.
 * `past` — день настоящий, но раньше `today` (тоже YYYY-MM-DD по Камчатке).
 */
export type CalendarDateRead =
  | { kind: 'absent' }
  | { kind: 'date'; date: string; past: boolean }
  | { kind: 'invalid'; raw: string };

export function readCalendarDate(raw: string | undefined | null, today: string): CalendarDateRead {
  const text = (raw ?? '').trim();
  if (!text) return { kind: 'absent' };
  if (!isRealDate(text)) return { kind: 'invalid', raw: text.slice(0, 40) };
  return { kind: 'date', date: text, past: text < today };
}

/** DD.MM для подписи. */
export function ruShort(date: string): string {
  const [, m, d] = date.split('-');
  return `${d}.${m}`;
}

/**
 * Момент из строки БД («2026-09-29 10:14:02.317308+03») — по-камчатски, ДД.ММ ЧЧ:ММ.
 * Не разобралась — null: подставленное «сейчас» соврало бы про свежесть.
 */
export function fmtKamchatka(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // «+03» без минут Date не понимает.
  const iso = raw.trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const k = new Date(t.getTime() + OFFSET_MS).toISOString(); // YYYY-MM-DDTHH:MM:SS
  return `${k.slice(8, 10)}.${k.slice(5, 7)} ${k.slice(11, 16)}`;
}
