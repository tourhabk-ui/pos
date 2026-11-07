/**
 * Дата и число людей из реплики туриста — для карточки заявки в чате
 * Кузьмича (01.11, «Кузьмич сам оформляет заявку»). Имя, телефон и почту
 * отсюда НЕ читаем: их человек вводит в карточке с галочкой согласия.
 */
export interface ChatBookingPrefill {
  date?: string;
  /**
   * Конец названного диапазона («с 5 по 12 июля», «28 июля — 3 августа»,
   * «05.07–12.07»); `date` тогда — его начало (аудит планировщика 07.11, K6:
   * до этого из «с 5 по 12 июля» бралось 12 июля — первая найденная пара
   * «число + месяц», и заявка уходила на день отъезда).
   */
  dateEnd?: string;
  guests?: number;
  /** Названа дата, которая уже прошла («15.11.24»): заявки нет, переспрос (#2967). */
  pastDate?: string;
}

/** Формы месяца целиком: «ма» без границы читало «3 маленьких» как 3 мая (#2967). */
const MONTH_FORMS: Array<[RegExp, number]> = [
  [/^январ[ьяе]$/, 1], [/^феврал[ьяе]$/, 2], [/^март[ае]?$/, 3], [/^апрел[ьяе]$/, 4],
  [/^ма[йяе]$/, 5], [/^июн[ьяе]$/, 6], [/^июл[ьяе]$/, 7], [/^август[ае]?$/, 8],
  [/^сентябр[ьяе]$/, 9], [/^октябр[ьяе]$/, 10], [/^ноябр[ьяе]$/, 11], [/^декабр[ьяе]$/, 12],
];

function monthOf(word: string): number | undefined {
  return MONTH_FORMS.find(([re]) => re.test(word))?.[1];
}

/** После «1.5» или «2.50» стоит единица — это число, не дата. */
const UNIT_AFTER = /^\s*(?:час|ч\b|мин|км|м\b|метр|руб|р\.|₽|%|кг|л\b|литр|тыс|раз|балл)/;

const WORD_GUESTS: Array<[RegExp, number]> = [
  [/(?:^|[^а-яё])(?:я\s+один|я\s+одна|один\s+человек|на\s+одного)(?![а-яё])/, 1],
  [/(?:^|[^а-яё])(?:вдво[её]м|на\s+двоих|двое)(?![а-яё])/, 2],
  [/(?:^|[^а-яё])(?:втро[её]м|на\s+троих|трое)(?![а-яё])/, 3],
  [/(?:^|[^а-яё])(?:вчетвером|на\s+четверых|четверо)(?![а-яё])/, 4],
  [/(?:^|[^а-яё])(?:впятером|на\s+пятерых|пятеро)(?![а-яё])/, 5],
  [/(?:^|[^а-яё])(?:вшестером|на\s+шестерых|шестеро)(?![а-яё])/, 6],
];

function iso(y: number, m: number, d: number): string | undefined {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseChatBookingPrefill(text: string, today: Date = new Date()): ChatBookingPrefill {
  const t = text.toLowerCase().replace(/ё/g, 'е');
  const out: ChatBookingPrefill = {};
  const todayIso = today.toISOString().slice(0, 10);
  const thisYear = today.getUTCFullYear();
  // Год назван — дату не переносим: прошедшая идёт в pastDate, а не в заявку.
  const dated = (y: number | undefined, m: number, d: number): string | undefined => {
    if (y !== undefined) {
      const v = iso(y, m, d);
      if (v && v < todayIso) { out.pastDate = v; return undefined; }
      return v;
    }
    let v = iso(thisYear, m, d);
    if (v && v <= todayIso) v = iso(thisYear + 1, m, d);
    return v;
  };
  // Диапазон — раньше одиночной даты: иначе находилась вторая его граница.
  const range = findRange(t, dated);
  if (range === 'bad') return guestsOf(t, out);
  if (range) {
    out.date = range.start;
    out.dateEnd = range.end;
    return guestsOf(t, out);
  }
  const m = /(?<!\d)(20\d{2})-(\d{2})-(\d{2})(?!\d)/.exec(t);
  if (m) out.date = dated(+m[1], +m[2], +m[3]);
  if (!out.date && !out.pastDate) {
    // dd.mm — дата, только если месяц двузначный или назван год, и после нет
    // единицы: «1.5 часа езды» — не 1 мая, «2.50 км» — не дата.
    for (const d of t.matchAll(/(?<![\d.,])(\d{1,2})\.(\d{1,2})(?:\.(20\d{2}|\d{2}))?(?![\d.,]\d)/g)) {
      const after = t.slice((d.index ?? 0) + d[0].length);
      if (UNIT_AFTER.test(after)) continue;
      if (d[2].length < 2 && !d[3]) continue;
      const y = d[3] ? (d[3].length === 2 ? 2000 + +d[3] : +d[3]) : undefined;
      const v = dated(y, +d[2], +d[1]);
      if (v) { out.date = v; break; }
      if (out.pastDate) break;
    }
  }
  if (!out.date && !out.pastDate) {
    for (const d of t.matchAll(/(?<!\d)(\d{1,2})(?:-?го)?\s+([а-я]+)(?:\s+(20\d{2}))?/g)) {
      const month = monthOf(d[2]);
      if (!month) continue;
      const v = dated(d[3] ? +d[3] : undefined, month, +d[1]);
      if (v) { out.date = v; break; }
      if (out.pastDate) break;
    }
  }
  if (!out.date) delete out.date;
  return guestsOf(t, out);
}

function guestsOf(t: string, out: ChatBookingPrefill): ChatBookingPrefill {
  const g = /(?<![\d.,])(\d{1,2})\s*(?:чел|человек|взросл|гост|участник|туриста|туристов)/.exec(t)
    ?? /(?:^|[^а-я])нас\s+(\d{1,2})(?![\d.,:])/.exec(t);
  if (g && +g[1] >= 1 && +g[1] <= 50) out.guests = +g[1];
  if (out.guests === undefined) {
    const w = WORD_GUESTS.find(([re]) => re.test(t));
    if (w) out.guests = w[1];
  }
  return out;
}

/** Самая длинная поездка, которую диапазон в реплике может значить. */
const MAX_RANGE_DAYS = 60;
const SEP = '\\s*(?:[–—-]|по|до)\\s*';
/** «28 июля — 3 августа», «с 10 июля по 17 июля». */
const RANGE_TWO_MONTHS = new RegExp(`(?<![\\d.])(\\d{1,2})(?:-?го)?\\s+([а-я]+)(?:\\s+(20\\d{2}))?${SEP}(\\d{1,2})(?:-?го)?\\s+([а-я]+)(?:\\s+(20\\d{2}))?`, 'g');
/** «с 5 по 12 июля», «5–12 июля», «с 10 до 17 июля». */
const RANGE_ONE_MONTH = new RegExp(`(?<![\\d.])(\\d{1,2})(?:-?го)?${SEP}(\\d{1,2})(?:-?го)?\\s+([а-я]+)(?:\\s+(20\\d{2}))?`, 'g');
/** «05.07–12.07», «5.07–12.07.2027», «5–12.07». */
const RANGE_NUMERIC = /(?<![\d.,])(\d{1,2})(?:\.(\d{2})(?:\.(20\d{2}|\d{2}))?)?\s*[–—-]\s*(\d{1,2})\.(\d{2})(?:\.(20\d{2}|\d{2}))?(?![\d.,]\d)/;
/** Две даты ISO: «2027-07-05 — 2027-07-12». */
const RANGE_ISO = /(?<!\d)(20\d{2})-(\d{2})-(\d{2})\s*(?:[–—]|-|по|до)\s*(20\d{2})-(\d{2})-(\d{2})(?!\d)/;

type Dated = (y: number | undefined, m: number, d: number) => string | undefined;

function fullYear(y: string | undefined): number | undefined {
  if (!y) return undefined;
  return y.length === 2 ? 2000 + Number(y) : Number(y);
}

interface RangeParts { d1: number; m1: number; y1?: number; d2: number; m2: number; y2?: number }

/** Первый диапазон словами или числами — и насколько он однозначен. */
function rangeParts(t: string): { parts: RangeParts; explicit: boolean } | null {
  const iso = RANGE_ISO.exec(t);
  if (iso) return { parts: { y1: +iso[1], m1: +iso[2], d1: +iso[3], y2: +iso[4], m2: +iso[5], d2: +iso[6] }, explicit: true };
  for (const r of t.matchAll(RANGE_TWO_MONTHS)) {
    const m1 = monthOf(r[2]);
    const m2 = monthOf(r[5]);
    if (m1 && m2) return { parts: { d1: +r[1], m1, y1: fullYear(r[3]), d2: +r[4], m2, y2: fullYear(r[6]) }, explicit: true };
  }
  for (const r of t.matchAll(RANGE_ONE_MONTH)) {
    const m = monthOf(r[3]);
    const y = fullYear(r[4]);
    if (m) return { parts: { d1: +r[1], m1: m, y1: y, d2: +r[2], m2: m, y2: y }, explicit: true };
  }
  const r = RANGE_NUMERIC.exec(t);
  // Числами — только когда после нет единицы: «2.50-3.20 км» — не даты.
  if (r && !UNIT_AFTER.test(t.slice((r.index ?? 0) + r[0].length))) {
    const m2 = +r[5];
    const y2 = fullYear(r[6]);
    return { parts: { d1: +r[1], m1: r[2] ? +r[2] : m2, y1: fullYear(r[3]) ?? y2, d2: +r[4], m2, y2 }, explicit: false };
  }
  return null;
}

/**
 * Диапазон дат в реплике. Начало — по тем же правилам, что одиночная дата
 * (год не назван — ближайший впереди; назван и прошёл — pastDate). Конец —
 * в году начала, а через Новый год («28 декабря — 5 января») — в следующем.
 *
 * Диапазон словами, которого не бывает («17–10 июля», «с 31 июня по 5
 * июля», длиннее двух месяцев), — 'bad': даты нет, чат её переспросит, а не
 * возьмёт половину диапазона. Числа без месяца словом, которые датой не
 * читаются («2.50-3.20»), — не диапазон вовсе: одиночная дата ищется дальше.
 */
function findRange(t: string, dated: Dated): { start: string; end: string } | 'bad' | null {
  const found = rangeParts(t);
  if (!found) return null;
  const c = found.parts;
  const fail = found.explicit ? 'bad' as const : null;
  if (!iso(c.y1 ?? 2000, c.m1, c.d1) || !iso(c.y2 ?? 2000, c.m2, c.d2)) return fail;
  if (c.m1 === c.m2 && c.d2 < c.d1 && (c.y2 === undefined || c.y2 === c.y1)) return fail;
  const start = dated(c.y1, c.m1, c.d1);
  if (!start) return 'bad';
  const startYear = Number(start.slice(0, 4));
  let end = iso(c.y2 ?? startYear, c.m2, c.d2);
  // Через Новый год без названного года: «28 декабря — 5 января».
  if (end && end < start && c.y2 === undefined) end = iso(startYear + 1, c.m2, c.d2);
  if (!end || end < start) return fail;
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
  if (days > MAX_RANGE_DAYS) return fail;
  return { start, end };
}
