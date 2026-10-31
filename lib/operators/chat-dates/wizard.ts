/**
 * Даты кнопками в чате кабинета MAX (31.10, слово владельца «Б: даты
 * кнопками»): тур → месяц → дни (каждый день / выходные / будни) → места →
 * то же предложение с «Открыть», что у фразы. Всё в одном сообщении: каждая
 * кнопка правит его на месте.
 *
 * Кнопки только собирают то, что человек написал бы фразой. Предложение,
 * проверка каждой даты (прошла, за горизонтом, закрыта, вне сезона, есть
 * брони) и запись — общие с фразой (`flow.ts`, `proposals.ts`): второго
 * пути записи дат здесь нет, и без «Открыть» ничего не меняется.
 *
 * Payload — без состояния в базе, всё в самой кнопке, до 64 байт:
 *   dw:t                          — выбрать тур
 *   dw:m:<тур>                    — выбрать месяц
 *   dw:d:<тур>:<ггггмм>           — выбрать дни
 *   dw:s:<тур>:<ггггмм>:<a|e|w>   — выбрать места
 *   dw:g:<тур>:<ггггмм>:<a|e|w>:<места> — показать предложение с «Открыть»
 *   dw:x                          — передумал
 * Права кнопка не даёт: чей чат и чей тур, решает поток по карточке чата
 * (`wizard-flow.ts`) и запись (`pressOpen`, тур — по operator_id карточки).
 *
 * Модуль без базы и сети. Сторож: tests/unit/chat-dates-wizard.test.ts.
 */

import { escapeHtml } from '@/lib/text/escape-html';
import { horizonLastDate, MAX_SLOTS_PER_DATE } from '@/lib/tours/availability-open';
import { type ChatTour, MAX_TOUR_BUTTONS, weekdayOf } from './parse';

export interface WizardButton {
  text: string;
  payload: string;
  intent?: 'positive' | 'negative';
}

export interface WizardStep {
  text: string;
  rows: WizardButton[][];
}

/** a — каждый день, e — выходные (сб, вс), w — будни (пн–пт). */
export type WizardPattern = 'a' | 'e' | 'w';

export type WizardPress =
  | { step: 'tours' }
  | { step: 'cancel' }
  | { step: 'month'; tourId: string }
  | { step: 'days'; tourId: string; month: string }
  | { step: 'seats'; tourId: string; month: string; pattern: WizardPattern }
  | { step: 'go'; tourId: string; month: string; pattern: WizardPattern; seats: number };

/** Места кнопками; другое число — фразой. */
export const WIZARD_SEATS: readonly number[] = [2, 4, 6, 8, 10, 12];
/** Месяцев кнопками: текущий и три следующих. */
export const WIZARD_MONTHS = 4;

const GEN_MONTH = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const NOM_MONTH = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const PATTERN_WORD: Record<WizardPattern, string> = { a: 'Каждый день', e: 'Выходные', w: 'Будни' };

/** «2026-12» ↔ «202612» — в кнопке без дефиса. */
const toCode = (month: string): string => month.replace('-', '');
const fromCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4, 6)}`;

export const dw = {
  tours: (): string => 'dw:t',
  cancel: (): string => 'dw:x',
  month: (tourId: string): string => `dw:m:${tourId}`,
  days: (tourId: string, month: string): string => `dw:d:${tourId}:${toCode(month)}`,
  seats: (tourId: string, month: string, p: WizardPattern): string => `dw:s:${tourId}:${toCode(month)}:${p}`,
  go: (tourId: string, month: string, p: WizardPattern, seats: number): string => `dw:g:${tourId}:${toCode(month)}:${p}:${seats}`,
};

const TOUR = '(\\d{1,19})';
const MONTH = '(20\\d{2}(?:0[1-9]|1[0-2]))';
const PAT = '([aew])';
const RE = {
  month: new RegExp(`^dw:m:${TOUR}$`),
  days: new RegExp(`^dw:d:${TOUR}:${MONTH}$`),
  seats: new RegExp(`^dw:s:${TOUR}:${MONTH}:${PAT}$`),
  go: new RegExp(`^dw:g:${TOUR}:${MONTH}:${PAT}:(\\d{1,3})$`),
};

/** Разбор кнопки; чужая форма или места вне 1–500 — null. */
export function parseWizardPayload(payload: string): WizardPress | null {
  if (payload === 'dw:t') return { step: 'tours' };
  if (payload === 'dw:x') return { step: 'cancel' };
  let m = payload.match(RE.month);
  if (m) return { step: 'month', tourId: m[1]! };
  m = payload.match(RE.days);
  if (m) return { step: 'days', tourId: m[1]!, month: fromCode(m[2]!) };
  m = payload.match(RE.seats);
  if (m) return { step: 'seats', tourId: m[1]!, month: fromCode(m[2]!), pattern: m[3] as WizardPattern };
  m = payload.match(RE.go);
  if (m) {
    const seats = Number(m[4]);
    if (seats < 1 || seats > MAX_SLOTS_PER_DATE) return null;
    return { step: 'go', tourId: m[1]!, month: fromCode(m[2]!), pattern: m[3] as WizardPattern, seats };
  }
  return null;
}

/** Текущий месяц и три следующих — «2026-11». */
export function wizardMonths(today: string): string[] {
  const [y0, m0] = today.split('-').map(Number) as [number, number];
  return Array.from({ length: WIZARD_MONTHS }, (_, i) => {
    const m = ((m0 - 1 + i) % 12) + 1;
    const y = y0 + Math.floor((m0 - 1 + i) / 12);
    return `${y}-${String(m).padStart(2, '0')}`;
  });
}

function matches(date: string, p: WizardPattern): boolean {
  if (p === 'a') return true;
  const wd = weekdayOf(date);
  return p === 'e' ? wd >= 5 : wd <= 4;
}

/** Даты месяца по выбору дней: не раньше сегодняшнего и не дальше года вперёд (горизонт записи). */
export function wizardDates(month: string, p: WizardPattern, today: string): string[] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const horizon = horizonLastDate(today);
  const out: string[] = [];
  for (let d = 1; d <= last; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    if (date < today || date > horizon) continue;
    if (matches(date, p)) out.push(date);
  }
  return out;
}

/** «выходные декабря 2026» — строка «Правило» предложения. */
export function wizardRule(month: string, p: WizardPattern): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  if (p === 'a') return `все дни ${GEN_MONTH[m - 1]} ${y}`;
  return `${p === 'e' ? 'выходные' : 'будни'} ${GEN_MONTH[m - 1]} ${y}`;
}

function monthLabel(month: string, today: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return y === Number(today.slice(0, 4)) ? NOM_MONTH[m - 1]! : `${NOM_MONTH[m - 1]} ${y}`;
}

const tourLine = (title: string): string => `Тур: «${escapeHtml(title.replace(/\s+/g, ' ').trim())}»`;
const clipButton = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 40 ? `${t.slice(0, 39).trimEnd()}…` : t;
};

const cancelButton: WizardButton = { text: 'Отмена', payload: dw.cancel(), intent: 'negative' };

/** По два в ряд: MAX делит ряд поровну, третья кнопка с месяцем и годом режется. */
function pairs(buttons: WizardButton[]): WizardButton[][] {
  const rows: WizardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}

/** Шаг 1. Живые туры кнопками; скрытые — словами: даты им не открываются. */
export function toursStep(tours: readonly ChatTour[]): WizardStep {
  const live = tours.filter((t) => t.active);
  const shown = live.slice(0, MAX_TOUR_BUTTONS);
  const lines = ['<b>Открыть даты</b>', 'Для какого тура?'];
  if (live.length > shown.length) {
    lines.push(`Кнопками — первые ${shown.length} из ${live.length}. Остальные — фразой с названием тура.`);
  }
  const hidden = tours.length - live.length;
  if (hidden > 0) lines.push(`Скрытым турам (${hidden}) даты не открываются, их здесь нет.`);
  return {
    text: lines.join('\n'),
    rows: [...shown.map((t) => [{ text: clipButton(t.title), payload: dw.month(t.id) }]), [cancelButton]],
  };
}

/** Шаг 2. Месяц. «Назад» — к выбору тура, только когда туров больше одного. */
export function monthStep(tour: ChatTour, today: string, backToTours: boolean): WizardStep {
  const months = wizardMonths(today);
  return {
    text: ['<b>Открыть даты</b>', tourLine(tour.title), 'Какой месяц?'].join('\n'),
    rows: [
      ...pairs(months.map((mo) => ({ text: monthLabel(mo, today), payload: dw.days(tour.id, mo) }))),
      backToTours ? [{ text: '‹ Тур', payload: dw.tours() }, cancelButton] : [cancelButton],
    ],
  };
}

/** Шаг 3. Дни. На кнопке — сколько дат осталось; где ноль — кнопки нет. */
export function daysStep(tour: ChatTour, month: string, today: string): WizardStep {
  const options = (['a', 'e', 'w'] as const)
    .map((p) => ({ p, n: wizardDates(month, p, today).length }))
    .filter((o) => o.n > 0);
  const lines = ['<b>Открыть даты</b>', tourLine(tour.title), `Месяц: ${monthLabel(month, today)}`];
  lines.push(options.length > 0 ? 'Какие дни?' : `В ${monthLabel(month, today).toLowerCase()} дней не осталось — выберите другой месяц.`);
  if (options.some((o) => o.p !== 'a')) lines.push('Выходные — суббота и воскресенье, будни — с понедельника по пятницу; праздники не учитываются.');
  return {
    text: lines.join('\n'),
    rows: [
      ...options.map((o) => [{ text: `${PATTERN_WORD[o.p]} (${o.n})`, payload: dw.seats(tour.id, month, o.p) }]),
      [{ text: '‹ Месяц', payload: dw.month(tour.id) }, cancelButton],
    ],
  };
}

/** Шаг 4. Места на каждый выезд. Другое число — фразой, с образцом из этого же выбора. */
export function seatsStep(tour: ChatTour, month: string, p: WizardPattern, today: string): WizardStep {
  const n = wizardDates(month, p, today).length;
  const phrase = `«открой ${p === 'a' ? 'весь' : p === 'e' ? 'выходные' : 'будни'} ${p === 'a' ? monthNom(month) : monthGenShort(month)}, 15 мест»`;
  const buttons = WIZARD_SEATS.map((s) => ({ text: String(s), payload: dw.go(tour.id, month, p, s) }));
  return {
    text: [
      '<b>Открыть даты</b>',
      tourLine(tour.title),
      `Дни: ${wizardRule(month, p)} — ${n} ${plural(n, 'дата', 'даты', 'дат')}`,
      'Сколько мест на каждый выезд?',
      `Другое число — фразой, например ${phrase}.`,
    ].join('\n'),
    rows: [
      buttons.slice(0, 3),
      buttons.slice(3),
      [{ text: '‹ Дни', payload: dw.days(tour.id, month) }, cancelButton],
    ],
  };
}

function monthNom(month: string): string {
  return NOM_MONTH[Number(month.slice(5, 7)) - 1]!.toLowerCase();
}
function monthGenShort(month: string): string {
  return GEN_MONTH[Number(month.slice(5, 7)) - 1]!;
}

function plural(n: number, one: string, few: string, many: string): string {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return one;
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return few;
  return many;
}

/** Итог «Отмена» и «дат не осталось» на шаге «Открыть». */
export const WIZARD_TEXT = {
  cancelled: 'Хорошо, ничего не открываю.',
  groupChat: 'Открывать даты можно только в личном диалоге со мной: в группе кнопку «Открыть» нажал бы любой участник. '
    + 'Ничего не открыто.',
  badButton: 'Кнопка не распознана — ничего не изменено. Нажмите «Обновить места» ещё раз.',
  tourGone: 'Этого тура больше нет среди ваших живых — ничего не открыто. Выберите тур заново.',
  noDatesLeft: (month: string, p: WizardPattern) => `${wizardRule(month, p).replace(/^\S/, (c) => c.toUpperCase())} уже прошли — ничего не открыто. Выберите другой месяц.`,
} as const;
