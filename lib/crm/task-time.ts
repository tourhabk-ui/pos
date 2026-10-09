/**
 * lib/crm/task-time.ts — срок задачи по-камчатски (CRM 1в, #2325). Чистые
 * функции: их читает экран кабинета и сторож.
 *
 * Лента и карточка показывают моменты по Камчатке, значит и срок вводится
 * по Камчатке: «перезвонить в 10:00» — это 10:00 у клиента и у партнёра, а
 * не в поясе браузера, открытого в Москве. Смещение постоянное (UTC+12, без
 * летнего времени) — `KAMCHATKA_UTC_OFFSET_HOURS`.
 */
import { KAMCHATKA_UTC_OFFSET_HOURS, kamchatkaDate, shiftDate } from '@/lib/analytics/kamchatka-day';

const OFFSET = `+${String(KAMCHATKA_UTC_OFFSET_HOURS).padStart(2, '0')}:00`;
const HOUR_MS = 3_600_000;

/**
 * Значение `<input type="datetime-local">` («2026-10-10T10:00»), прочитанное
 * как камчатское время, — в ISO-момент. Не похоже на дату — null, а не
 * «сейчас»: подставленный срок соврал бы о договорённости.
 */
export function kamchatkaLocalToIso(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const back = new Date(Date.UTC(y, mo - 1, d));
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  const t = new Date(`${value.trim()}:00${OFFSET}`);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** Обратное: момент — в значение поля ввода по Камчатке. */
export function isoToKamchatkaLocal(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  return new Date(t.getTime() + KAMCHATKA_UTC_OFFSET_HOURS * HOUR_MS).toISOString().slice(0, 16);
}

/** Срок по умолчанию для новой задачи — завтра в 10:00 по Камчатке. */
export function defaultDueLocal(now: Date): string {
  return `${shiftDate(kamchatkaDate(now), 1)}T10:00`;
}

export type DueBucket = 'overdue' | 'today' | 'tomorrow' | 'later';

/**
 * Куда задача попадает на экране. Просрочена — срок уже прошёл (с точностью
 * до момента, не до суток: «в 10:00» в 11:00 уже просрочено); иначе — по
 * камчатскому календарю.
 */
export function dueBucket(dueIso: string, now: Date): DueBucket {
  const due = new Date(dueIso);
  if (due.getTime() < now.getTime()) return 'overdue';
  const today = kamchatkaDate(now);
  const day = kamchatkaDate(due);
  if (day === today) return 'today';
  if (day === shiftDate(today, 1)) return 'tomorrow';
  return 'later';
}

export const DUE_BUCKET_LABELS: Readonly<Record<DueBucket, string>> = {
  overdue: 'Просрочено',
  today: 'Сегодня',
  tomorrow: 'Завтра',
  later: 'Позже',
};
