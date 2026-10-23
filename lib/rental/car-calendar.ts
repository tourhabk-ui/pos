/**
 * Календарь машины проката: 30 дней вперёд по Камчатке, чистые функции.
 *
 * День без строки в rental_car_busy — «не отмечено». Это не «свободна»:
 * свободна только явная отметка busy = false. Кнопки пишут отметку,
 * инструмент модели только читает.
 *
 * Payload кнопки короче 64 знаков: rb:o / rb:w / rb:s, uuid машины и дата.
 * Ни имени, ни цены, ни заявки в payload нет.
 */

import { isRealDate, ruShort, shiftDate } from '@/lib/analytics/kamchatka-day';
import { escapeHtml } from '@/lib/text/escape-html';

export const RENTAL_CALENDAR_DAYS = 30;
export const RENTAL_CALENDAR_PAGE = 7;

export const RENTAL_CALENDAR_TOOL_NAME = 'operator_rental_calendar';

export const RENTAL_CALENDAR_TOOL = {
  type: 'function' as const,
  function: {
    name: RENTAL_CALENDAR_TOOL_NAME,
    description:
      'Отметки занятости своих машин на 30 дней вперёд по Камчатке. '
      + 'День «не отмечено» — отметки нет, это не «свободна». Отметку инструмент не ставит.',
    parameters: {
      type: 'object',
      properties: {
        car: { type: 'string', description: 'Необязательно: часть названия машины' },
      },
    },
  },
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const DAY = String.raw`\d{4}-\d{2}-\d{2}`;
const OPEN_RE = new RegExp(`^rb:o:(${UUID})$`, 'i');
const WINDOW_RE = new RegExp(`^rb:w:(${UUID}):(${DAY})$`, 'i');
const SET_RE = new RegExp(`^rb:s:(${UUID}):(${DAY}):([01])$`, 'i');

export interface CalendarCar {
  id: string;
  title: string;
  active: boolean;
}

export interface CalendarButton {
  text: string;
  payload: string;
  intent?: 'positive' | 'negative';
}

export type CalendarPress =
  | { kind: 'list' }
  | { kind: 'open'; offerId: string }
  | { kind: 'window'; offerId: string; start: string }
  | { kind: 'set'; offerId: string; day: string; busy: boolean };

/** «календарь», «занятость», с необязательным названием. Чужая фраза — null. */
export function calendarAsk(text: string): { car: string } | null {
  const t = text.trim().toLowerCase().replace(/[.!?…]+$/g, '').replace(/\s+/g, ' ');
  if (t.length === 0 || t.length > 80) return null;
  const m = t.match(/^(?:покажи\s+)?(?:мой\s+|моя\s+)?(?:календарь|занятость)(?:\s+(.+))?$/);
  if (!m) return null;
  const car = (m[1] ?? '').trim();
  if (car.length > 40) return null;
  return { car };
}

export function openPayload(offerId: string): string {
  return `rb:o:${offerId}`;
}

export function windowPayload(offerId: string, start: string): string {
  return `rb:w:${offerId}:${start}`;
}

export function setPayload(offerId: string, day: string, busy: boolean): string {
  return `rb:s:${offerId}:${day}:${busy ? '1' : '0'}`;
}

export function parseCalendarPress(payload: string): CalendarPress | null {
  if (payload === 'rb:list') return { kind: 'list' };
  const open = payload.match(OPEN_RE);
  if (open) return { kind: 'open', offerId: open[1]!.toLowerCase() };
  const window = payload.match(WINDOW_RE);
  if (window && isRealDate(window[2]!)) return { kind: 'window', offerId: window[1]!.toLowerCase(), start: window[2]! };
  const set = payload.match(SET_RE);
  if (set && isRealDate(set[2]!)) {
    return { kind: 'set', offerId: set[1]!.toLowerCase(), day: set[2]!, busy: set[3] === '1' };
  }
  return null;
}

export function horizonEnd(today: string): string {
  return shiftDate(today, RENTAL_CALENDAR_DAYS - 1);
}

export function withinHorizon(today: string, day: string): boolean {
  return isRealDate(today) && isRealDate(day) && day >= today && day <= horizonEnd(today);
}

/** Начало семидневной страницы, в которую попадает день. Вне горизонта — null. */
export function pageStartFor(today: string, day: string): string | null {
  if (!withinHorizon(today, day)) return null;
  for (let i = 0; i < RENTAL_CALENDAR_DAYS; i += RENTAL_CALENDAR_PAGE) {
    const start = shiftDate(today, i);
    const end = shiftDate(today, Math.min(i + RENTAL_CALENDAR_PAGE - 1, RENTAL_CALENDAR_DAYS - 1));
    if (day >= start && day <= end) return start;
  }
  return null;
}

export function pageDays(today: string, start: string): string[] {
  if (pageStartFor(today, start) !== start) return [];
  const days: string[] = [];
  for (let i = 0; i < RENTAL_CALENDAR_PAGE; i++) {
    const day = shiftDate(start, i);
    if (!withinHorizon(today, day)) break;
    days.push(day);
  }
  return days;
}

function markWord(mark: boolean | undefined): string {
  if (mark === true) return 'занята';
  if (mark === false) return 'свободна';
  return 'не отмечено';
}

function visibility(car: CalendarCar): string {
  return car.active ? 'в прайсе' : 'скрыта из прайса';
}

/** Текст списка или одного календаря. canMark — в этом чате есть кнопки отметки. */
export function calendarBody(opts: {
  cars: CalendarCar[];
  query: string;
  today: string;
  focus: CalendarCar | null;
  marks: ReadonlyMap<string, boolean>;
  canMark: boolean;
  /** Строка сверху, если запись только что не удалась или не принята. */
  notice?: string | null;
}): string {
  const lines: string[] = [];
  if (opts.notice) lines.push(opts.notice);
  if (opts.cars.length === 0) {
    lines.push(opts.query
      ? `В прайсе нет машины, в названии которой есть «${escapeHtml(opts.query)}».`
      : 'В прайсе нет ни одной машины. Календарь отмечать не на чем.');
    return lines.join('\n');
  }
  if (!opts.focus) {
    lines.push('Какую машину показать? День без отметки — не «свободна».');
    for (const car of opts.cars) lines.push(`- ${escapeHtml(car.title)} — ${visibility(car)}`);
    lines.push(opts.canMark
      ? 'Нажмите машину ниже или напишите «календарь» и часть названия.'
      : 'Напишите «календарь» и часть названия. Кнопки «Свободна» и «Занята» есть в MAX, здесь отметку не ставлю.');
    return lines.join('\n');
  }
  const end = horizonEnd(opts.today);
  lines.push(
    `${escapeHtml(opts.focus.title)} — ${visibility(opts.focus)}. `
    + `Отметки с ${ruShort(opts.today)} по ${ruShort(end)} (Камчатка).`,
  );
  lines.push('День «не отмечено» — отметки нет. Это не «свободна».');
  for (let i = 0; i < RENTAL_CALENDAR_DAYS; i++) {
    const day = shiftDate(opts.today, i);
    lines.push(`${ruShort(day)} ${markWord(opts.marks.get(day))}`);
  }
  if (opts.canMark) {
    lines.push('Кнопки ниже пишут отметку на семь дней. Остальные дни — стрелками «Дальше» и «Назад».');
  } else {
    lines.push('Отметить день кнопкой «Свободна» или «Занята» можно в MAX. Здесь календарь только для чтения.');
  }
  return lines.join('\n');
}

export function calendarButtons(opts: {
  today: string;
  offerId: string;
  start: string;
  showList: boolean;
}): CalendarButton[][] {
  const days = pageDays(opts.today, opts.start);
  if (days.length === 0) return [];
  const rows: CalendarButton[][] = days.map((day) => ([
    { text: `Свободна ${ruShort(day)}`, payload: setPayload(opts.offerId, day, false), intent: 'positive' as const },
    { text: `Занята ${ruShort(day)}`, payload: setPayload(opts.offerId, day, true), intent: 'negative' as const },
  ]));
  const prev = pageStartFor(opts.today, shiftDate(opts.start, -1));
  const nextStart = shiftDate(opts.start, RENTAL_CALENDAR_PAGE);
  const nav: CalendarButton[] = [];
  if (prev && prev !== opts.start) nav.push({ text: 'Назад', payload: windowPayload(opts.offerId, prev) });
  if (pageStartFor(opts.today, nextStart) === nextStart) {
    nav.push({ text: 'Дальше', payload: windowPayload(opts.offerId, nextStart) });
  }
  if (nav.length > 0) rows.push(nav);
  if (opts.showList) rows.push([{ text: 'Все машины', payload: 'rb:list' }]);
  return rows;
}

/** Кнопки выбора машины, не больше двенадцати: остальные названы текстом. */
export function carPickButtons(cars: CalendarCar[]): CalendarButton[][] {
  return cars.slice(0, 12).map((car) => [{
    text: car.title.replace(/[<>&]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Машина',
    payload: openPayload(car.id),
  }]);
}
