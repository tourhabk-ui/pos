/**
 * Дата и число людей из реплики туриста — для карточки заявки в чате
 * Кузьмича (01.11, «Кузьмич сам оформляет заявку»). Имя, телефон и почту
 * отсюда НЕ читаем: их человек вводит в карточке с галочкой согласия.
 */
export interface ChatBookingPrefill {
  date?: string;
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
  const g = /(?<![\d.,])(\d{1,2})\s*(?:чел|человек|взросл|гост|участник|туриста|туристов)/.exec(t)
    ?? /(?:^|[^а-я])нас\s+(\d{1,2})(?![\d.,:])/.exec(t);
  if (g && +g[1] >= 1 && +g[1] <= 50) out.guests = +g[1];
  if (out.guests === undefined) {
    const w = WORD_GUESTS.find(([re]) => re.test(t));
    if (w) out.guests = w[1];
  }
  return out;
}
