/**
 * Предзаполнение формы заявки из адреса — путь браузерного ИИ-агента без MCP
 * (01.11, S1 из agentic-booking-industry-2026-11-01.md). Агент (ChatGPT agent,
 * Claude в Chrome, Gemini) или человек по ссылке открывает
 *   /catalog/tours/<slug>?date=2027-07-15&guests=3#booking
 * и получает готовую форму: остаются имя, телефон и согласие на ПД — их
 * из адреса НЕ берём (персональные данные в URL оседают в логах и истории).
 * Это заявка, не бронь: подтверждает оператор.
 */
export const GUEST_PARAMS = ['guests', 'people', 'participants', 'adults'] as const;

export interface RequestPrefill { date?: string; guests?: number }

export function parseRequestPrefill(search: string, maxGuests: number): RequestPrefill {
  const p = new URLSearchParams(search);
  const out: RequestPrefill = {};
  const d = p.get('date');
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d))) out.date = d;
  for (const k of GUEST_PARAMS) {
    const raw = p.get(k);
    if (!raw || !/^\d{1,3}$/.test(raw.trim())) continue;
    const n = parseInt(raw, 10);
    if (n >= 1) { out.guests = Math.min(n, Math.max(1, maxGuests)); break; }
  }
  return out;
}

/** Ссылка на готовую форму заявки тура. */
export function tourRequestHref(tourPathname: string, opts: RequestPrefill = {}): string {
  const p = new URLSearchParams();
  if (opts.date) p.set('date', opts.date);
  if (opts.guests) p.set('guests', String(opts.guests));
  const q = p.toString();
  return `${tourPathname}${q ? `?${q}` : ''}#booking`;
}

/** «<id>~<query>» от request/page.tsx → id карточки и предзаполнение. Без «~» — как было. */
export function splitPrefillId(raw: string, maxGuests = 100): { id: string; prefill: RequestPrefill } {
  const decoded = decodeURIComponent(raw);
  const i = decoded.indexOf('~');
  if (i < 0) return { id: raw, prefill: {} };
  return { id: decoded.slice(0, i), prefill: parseRequestPrefill(`?${decoded.slice(i + 1)}`, maxGuests) };
}
