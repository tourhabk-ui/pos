/**
 * Дата и число людей из реплики туриста — для карточки заявки в чате
 * Кузьмича (01.11, «Кузьмич сам оформляет заявку»). Имя, телефон и почту
 * отсюда НЕ читаем: их человек вводит в карточке с галочкой согласия.
 */
export interface ChatBookingPrefill { date?: string; guests?: number }

const MONTHS: Record<string, number> = {
  январ: 1, феврал: 2, март: 3, апрел: 4, ма: 5, июн: 6, июл: 7, август: 8, сентябр: 9, октябр: 10, ноябр: 11, декабр: 12,
};

function iso(y: number, m: number, d: number): string | undefined {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseChatBookingPrefill(text: string, today: Date = new Date()): ChatBookingPrefill {
  const t = text.toLowerCase();
  const out: ChatBookingPrefill = {};
  const thisYear = today.getUTCFullYear();
  const future = (y: number | undefined, m: number, d: number) => {
    const year = y ?? thisYear;
    let v = iso(year, m, d);
    if (v && y === undefined && v <= today.toISOString().slice(0, 10)) v = iso(year + 1, m, d);
    return v;
  };
  let m = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(t);
  if (m) out.date = iso(+m[1], +m[2], +m[3]);
  if (!out.date && (m = /\b(\d{1,2})\.(\d{1,2})(?:\.(20\d{2}|\d{2}))?\b/.exec(t))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : undefined;
    out.date = future(y, +m[2], +m[1]);
  }
  if (!out.date && (m = /\b(\d{1,2})\s+(январ|феврал|март|апрел|ма|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-я]*(?:\s+(20\d{2}))?/.exec(t))) {
    out.date = future(m[3] ? +m[3] : undefined, MONTHS[m[2]], +m[1]);
  }
  if (!out.date) delete out.date;
  const g = /\b(\d{1,2})\s*(?:чел|человек|взросл|гост|участник|туриста|туристов)/.exec(t)
    ?? /(?:^|[^а-яё])нас\s+(\d{1,2})\b/.exec(t);
  if (g && +g[1] >= 1 && +g[1] <= 50) out.guests = +g[1];
  return out;
}
