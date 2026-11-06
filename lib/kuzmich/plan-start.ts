/**
 * lib/kuzmich/plan-start.ts — когда считать поездку: разбор поля `when`
 * инструмента плана (Кузьмич, MCP `make_trip_plan`, ссылка в планер).
 *
 * До 19.09 старт был зашит как `now + 30 дней`. Потом разбор научился
 * месяцу («в июле» → 10-е), но не числу. Аудит планировщика 07.11 (M1, M2)
 * нашёл:
 *  - «15 июля» и «10–17 июля» считались на 10 июля без единого слова;
 *  - «2027-02-30» проходило как 2 марта: движок дат JS переносит лишние дни;
 *  - сегодняшняя дата считалась прошедшей, и план уезжал на месяц вперёд с
 *    пометкой «уже прошло»;
 *  - «15 мая» не узнавалось вовсе: в формах мая не было родительного падежа.
 * Аудит MCP 25.10 (п. 1, #2793) — о том же с другой стороны: агент, получивший
 * план на другую дату вместо своей, продолжает работу, как будто его дата
 * принята. Это опаснее отказа.
 *
 * Исходы (§4.0): не сказано — через месяц; разобрано (с концом диапазона или
 * без); уже прошло — через месяц, и это сказано; не дата, такой даты нет или
 * конец раньше начала — отказ без плана. У отказа даты нет вовсе: подставить
 * её нечем, и вызывающий не сможет сделать это по ошибке.
 *
 * «Сегодня» — по Камчатке: поездка, которая начинается сегодня, не прошла, а
 * «через месяц» считается от камчатского числа, полночью этой даты.
 */

import { kamchatkaDate, shiftDate } from '@/lib/analytics/kamchatka-day';

const DAY_MS = 86_400_000;

/** День месяца для «хочу в июле»: середина, а не край с его погодой. */
const MONTH_ANCHOR_DAY = 10;

/** «Не сказано» и «уже прошло» — через столько камчатских суток от сегодня. */
const DEFAULT_START_IN_DAYS = 30;

export type PlanStartRefusal = 'not_a_date' | 'no_such_date' | 'bad_range';

export type PlanStart =
  | { kind: 'default'; date: Date }
  /** `end` — конец диапазона («10–17 июля»), если он назван. */
  | { kind: 'parsed'; date: Date; end?: Date }
  | { kind: 'past'; date: Date; raw: string }
  | { kind: 'invalid'; raw: string; reason: PlanStartRefusal };

/**
 * Слово месяца. Формы — основами, у мая — с границей слова: «маяк» и
 * «майские» — не май. Родительный падеж («15 мая») — тоже май.
 */
const MONTH_TOKEN = '(январ[а-яё]*|феврал[а-яё]*|март[а-яё]*|апрел[а-яё]*|ма[йяею](?![а-яё])|июн[а-яё]*|июл[а-яё]*|август[а-яё]*|сентябр[а-яё]*|октябр[а-яё]*|ноябр[а-яё]*|декабр[а-яё]*)';
const MONTH_STEMS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];

function monthOf(token: string): number {
  const t = token.toLowerCase();
  for (let m = MONTH_STEMS.length - 1; m >= 0; m--) {
    // «ма» — начало и «марта»; поэтому май сверяется формой целиком.
    if (m === 4 ? /^ма[йяею]$/.test(t) : t.startsWith(MONTH_STEMS[m])) return m;
  }
  return -1;
}

/** Число словом-месяцем и необязательный год: «15 июля», «15-го июля 2027». */
const DAY_MONTH = `(?<![\\d.])(\\d{1,2})(?:-?го)?\\s+${MONTH_TOKEN}(?:\\s+(\\d{4}))?`;
const DASH = '\\s*(?:[–—-]|по|до)\\s*';
/** Диапазон в одном месяце: «10–17 июля», «с 10 по 17 июля». */
const RANGE_ONE_MONTH_RE = new RegExp(`(?<![\\d.])(\\d{1,2})(?:-?го)?${DASH}${DAY_MONTH}`, 'iu');
/** Диапазон через месяц: «28 июля — 3 августа», «с 10 июля по 17 июля». */
const RANGE_TWO_MONTHS_RE = new RegExp(`${DAY_MONTH}${DASH}${DAY_MONTH}`, 'iu');
const DAY_MONTH_RE = new RegExp(DAY_MONTH, 'iu');
/** «между 10 и 17 июля» — тот же диапазон, что «10–17 июля». */
const BETWEEN_RE = new RegExp(`между\\s+(\\d{1,2}(?:-?го)?(?:\\s+${MONTH_TOKEN}(?:\\s+\\d{4})?)?)\\s+и\\s+(?=\\d)`, 'iu');
/** Месяц без числа, необязательно с годом: «в июле», «июль 2027». Граница слева — «маяк» не май. */
const MONTH_ONLY_RE = new RegExp(`(?:^|[^а-яё])${MONTH_TOKEN}(?:\\s+(\\d{4}))?`, 'iu');
/**
 * Числами: «15.07», «15.07.2027», «15.07.27», диапазоны «10–17.07» и
 * «10.07–17.07.2027». Месяц — двумя цифрами: «1.5 месяца» — не 1 мая.
 */
const NUMERIC_RANGE_RE = /(?<![\d.])(\d{1,2})(?:\.(\d{2})(?:\.(\d{4}|\d{2}))?)?\s*[–—-]\s*(\d{1,2})\.(\d{2})(?:\.(\d{4}|\d{2}))?(?!\d)/;
const NUMERIC_RE = /(?<![\d.])(\d{1,2})\.(\d{2})(?:\.(\d{4}|\d{2}))?(?!\d)/;
const ISO_RE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
/** Слова-дни: считаются от камчатского сегодня. */
const RELATIVE_RE = /(?:^|[^а-яё])(сегодня|послезавтра|завтра)(?![а-яё])/u;
const RELATIVE_SHIFT: Record<string, number> = { сегодня: 0, завтра: 1, послезавтра: 2 };

/** Число, месяц (0–11) и год — настоящая дата? Движок дат переносит лишнее, поэтому сверка. */
function realDate(year: number, month: number, day: number): Date | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month && d.getUTCDate() === day ? d : null;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utcMidnight = (day: string) => new Date(`${day}T00:00:00Z`);

/** «27» → 2027, «2027» → 2027. */
function fullYear(raw: string | undefined): number | null {
  if (!raw) return null;
  return raw.length === 2 ? 2000 + Number(raw) : Number(raw);
}

interface Mention { day: number; month: number; year: number | null }

/**
 * Год для числа и месяца без года: ближайшие такие сутки, не раньше
 * сегодня по Камчатке. 29 февраля без года — ближайший високосный.
 */
function resolve(m: Mention, today: string): Date | null {
  if (m.year !== null) return realDate(m.year, m.month, m.day);
  // Такой даты нет ни в каком году («30 февраля»): 2028 — високосный.
  if (!realDate(2028, m.month, m.day)) return null;
  const year0 = Number(today.slice(0, 4));
  for (let y = year0; y <= year0 + 4; y++) {
    const d = realDate(y, m.month, m.day);
    if (d && iso(d) >= today) return d;
  }
  return null;
}

/** Названные даты по порядку: первая — начало, вторая — конец диапазона. */
function namedDates(text: string): Mention[] | null {
  const isoAll = [...text.matchAll(ISO_RE)];
  if (isoAll.length > 0) {
    return isoAll.slice(0, 2).map((m) => ({ year: Number(m[1]), month: Number(m[2]) - 1, day: Number(m[3]) }));
  }
  const two = RANGE_TWO_MONTHS_RE.exec(text);
  if (two) {
    return [
      { day: Number(two[1]), month: monthOf(two[2]), year: fullYear(two[3]) },
      { day: Number(two[4]), month: monthOf(two[5]), year: fullYear(two[6]) },
    ];
  }
  const one = RANGE_ONE_MONTH_RE.exec(text);
  if (one) {
    const month = monthOf(one[3]);
    const year = fullYear(one[4]);
    return [{ day: Number(one[1]), month, year }, { day: Number(one[2]), month, year }];
  }
  const dm = DAY_MONTH_RE.exec(text);
  if (dm) return [{ day: Number(dm[1]), month: monthOf(dm[2]), year: fullYear(dm[3]) }];
  const nr = NUMERIC_RANGE_RE.exec(text);
  if (nr) {
    const endMonth = Number(nr[5]) - 1;
    const endYear = fullYear(nr[6]);
    return [
      { day: Number(nr[1]), month: nr[2] ? Number(nr[2]) - 1 : endMonth, year: nr[2] ? fullYear(nr[3]) : endYear },
      { day: Number(nr[4]), month: endMonth, year: endYear },
    ];
  }
  const num = NUMERIC_RE.exec(text);
  if (num) return [{ day: Number(num[1]), month: Number(num[2]) - 1, year: fullYear(num[3]) }];
  return null;
}

/** Старт «через месяц»: камчатское сегодня + 30 суток, полночь этой даты. */
function defaultPlanStart(now: number): Date {
  return utcMidnight(shiftDate(kamchatkaDate(new Date(now)), DEFAULT_START_IN_DAYS));
}

export function parsePlanStart(raw: string | undefined, now: number): PlanStart {
  const fallback = defaultPlanStart(now);
  const original = (raw ?? '').trim();
  if (!original) return { kind: 'default', date: fallback };
  const said = original.slice(0, 60);
  const text = original.toLowerCase().replace(BETWEEN_RE, '$1 – ');
  const today = kamchatkaDate(new Date(now));
  const invalid = (reason: PlanStartRefusal): PlanStart => ({ kind: 'invalid', raw: said, reason });

  const named = namedDates(text);
  if (named) {
    const [first, second] = named;
    // Год назван только у конца («28 декабря — 5 января 2027»): начало — в
    // том же году или, если оно позже конца по календарю, в предыдущем.
    const startMention = first.year === null && second?.year != null
      ? { ...first, year: second.year - ((first.month * 32 + first.day) > (second.month * 32 + second.day) ? 1 : 0) }
      : first;
    const start = resolve(startMention, today);
    if (!start) return invalid('no_such_date');
    // Дата в прошлом — не «не понял», а «так нельзя»: починка разная, и
    // сказать надо разное. Сегодня по Камчатке — не прошлое.
    if (iso(start) < today) return { kind: 'past', date: fallback, raw: said };
    if (!second) return { kind: 'parsed', date: start };
    let end: Date | null;
    if (second.year !== null) {
      end = realDate(second.year, second.month, second.day);
    } else {
      if (!realDate(2028, second.month, second.day)) return invalid('no_such_date');
      // Конец без года — в году начала; «28 декабря — 5 января» — в следующем.
      // Только когда месяц конца раньше месяца начала: «17–10 июля» — не
      // поездка на год, а конец раньше начала.
      const yearOfStart = start.getUTCFullYear();
      end = realDate(yearOfStart, second.month, second.day);
      if (end && end.getTime() < start.getTime() && second.month < start.getUTCMonth()) {
        end = realDate(yearOfStart + 1, second.month, second.day);
      }
    }
    if (!end) return invalid('no_such_date');
    if (end.getTime() < start.getTime()) return invalid('bad_range');
    return { kind: 'parsed', date: start, end };
  }

  const rel = RELATIVE_RE.exec(text);
  if (rel) return { kind: 'parsed', date: utcMidnight(shiftDate(today, RELATIVE_SHIFT[rel[1]])) };

  const monthMatch = MONTH_ONLY_RE.exec(text);
  if (monthMatch) {
    const m = monthOf(monthMatch[1]);
    const year = fullYear(monthMatch[2]);
    if (year === null) {
      let y = Number(today.slice(0, 4));
      if (iso(new Date(Date.UTC(y, m, MONTH_ANCHOR_DAY))) < today) y += 1;
      return { kind: 'parsed', date: new Date(Date.UTC(y, m, MONTH_ANCHOR_DAY)) };
    }
    const anchor = new Date(Date.UTC(year, m, MONTH_ANCHOR_DAY));
    if (iso(anchor) >= today) return { kind: 'parsed', date: anchor };
    // «В ноябре 2026» 15 ноября: месяц ещё идёт — с сегодняшнего числа.
    const lastDay = new Date(Date.UTC(year, m + 1, 0));
    if (iso(lastDay) >= today) return { kind: 'parsed', date: utcMidnight(today) };
    return { kind: 'past', date: fallback, raw: said };
  }

  return invalid('not_a_date');
}

/** Дней в названном диапазоне, считая первый и последний; диапазона нет — null. */
export function rangeDays(start: PlanStart): number | null {
  if (start.kind !== 'parsed' || !start.end) return null;
  return Math.round((start.end.getTime() - start.date.getTime()) / DAY_MS) + 1;
}

/** Отказ без плана: что не так со сказанным и как назвать даты, чтобы план собрался. */
export function planStartRefusal(start: Extract<PlanStart, { kind: 'invalid' }>): string {
  switch (start.reason) {
    case 'no_such_date':
      return `Даты «${start.raw}» нет в календаре — план не собран: план на соседний день был бы ответом на другой вопрос. `
        + 'Назови настоящую дату — «15 июля», 15.07.2027 или 2027-07-15 — или месяц («в июле»).';
    case 'bad_range':
      return `В «${start.raw}» конец раньше начала — план не собран. Назови даты по порядку, например «10–17 июля».`;
    case 'not_a_date':
      return `«${start.raw}» не разобрал как дату поездки — план не собран, чтобы не посчитать его на другие даты. `
        + 'Назови месяц («в июле»), число («15 июля»), диапазон («10–17 июля») или дату 2027-07-15; даты — по Камчатке.';
  }
}
