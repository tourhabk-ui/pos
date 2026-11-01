/**
 * Тур для формы брони в веб-чате — тем же резолвером, что у мессенджеров
 * (lib/kuzmich/core.ts: chooseSellerForBooking → chooseTourForBooking).
 * До 01.11 веб-чат брал tourSuggestions[0] — первое совпадение по слову, и
 * форма открывалась на туре другой компании, если в реплике назван продавец
 * или подходящих туров несколько. Теперь: один тур — форма на нём; несколько —
 * формы нет, человек выбирает карточку сам; отказ базы — не угадываем.
 */
import { bookingWordsQuery, extractTourKeywords } from '@/lib/kuzmich/core';
import {
  resolveSellerInText,
  resolveTourChoice,
  type TourCandidate,
  type TourChoice,
} from '@/lib/kuzmich/tour-availability-tool';
import type { TourSuggestion } from '@/lib/ai/booking-intent';

export interface ChatBookingPick {
  /** Тур формы брони; null — однозначного тура нет. */
  tour: TourSuggestion | null;
  /** Туры на выбор, когда однозначного нет (для карточек). */
  candidates: TourSuggestion[];
}

export function candidateToSuggestion(c: TourCandidate): TourSuggestion {
  return {
    id: c.id,
    slug: c.slug ?? null,
    title: c.title,
    description: null,
    base_price: c.base_price == null ? 0 : Number(c.base_price),
    price_unit: c.price_unit,
    multi_day_count: c.multi_day_count ?? null,
    duration_hours: c.duration_hours ?? null,
    activity_type: null,
    location_type: null,
    location: c.place?.name ?? null,
    tour_image: null,
    operator_name: c.operator_name ?? '',
    operator_slug: null,
    operator_public: null,
    nearest_free_date: c.nearest_free_date,
  };
}

function choiceTours(choice: TourChoice): TourCandidate[] {
  switch (choice.kind) {
    case 'one': return [choice.tour];
    case 'ambiguous':
    case 'weak': return choice.candidates;
    case 'seller': return choice.tours;
    default: return [];
  }
}

export async function pickChatBookingTour(
  rawMessage: string,
  suggestions: TourSuggestion[],
): Promise<ChatBookingPick> {
  let choice: TourChoice | null;
  try {
    choice = await resolveSellerInText(rawMessage);
    if (!choice) {
      // Слова реплики раньше ключа вида: «зимняя рыбалка ноябрь январь» — тур 36.
      const words = bookingWordsQuery(rawMessage);
      const byWords = words ? await resolveTourChoice(words) : null;
      if (byWords?.kind === 'one') choice = byWords;
    }
    if (!choice) {
      const keywords = extractTourKeywords(rawMessage);
      choice = keywords.length ? await resolveTourChoice(keywords.join(' ')) : null;
    }
  } catch (err) {
    console.error('[ai/chat] тур для брони не прочитан', err instanceof Error ? err.message.slice(0, 200) : '');
    return { tour: null, candidates: [] };
  }
  if (choice?.kind === 'none') choice = null;
  if (!choice) {
    // Резолвер слов не нашёл; одна карточка в ходе — она и есть тур.
    if (suggestions.length === 1) return { tour: suggestions[0], candidates: [] };
    const n = narrowToursByText(rawMessage, suggestions);
    return { tour: n && n.base_price > 0 ? n : null, candidates: [] };
  }
  const tours = choiceTours(choice);
  if (choice.kind === 'one' || (choice.kind === 'seller' && tours.length === 1)) {
    const t = tours[0];
    const known = suggestions.find((s) => s.id === t.id);
    if (known) return { tour: known, candidates: [] };
    // Цены нет — «не записана», не ноль (§4.0): форме нечего считать.
    if (t.base_price == null) return { tour: null, candidates: [candidateToSuggestion(t)] };
    return { tour: candidateToSuggestion(t), candidates: [] };
  }
  const cands = tours.map(candidateToSuggestion);
  // Несколько туров — сужаем по словам реплики и месяцу даты (ретест 01.11:
  // «зимнюю рыбалку 15.11» → 36 «ноябрь — январь», не 37 и не осенняя).
  const narrowed = narrowToursByText(rawMessage, cands.length ? cands : suggestions);
  if (narrowed && narrowed.base_price > 0) return { tour: narrowed, candidates: [] };
  return { tour: null, candidates: cands };
}

const MONTH_STEMS = ['янв', 'фев', 'мар', 'апр', 'ма[йя]', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Один тур, чьё название совпадает с репликой по основам слов и месяцу даты; иначе null. */
export function narrowToursByText<T extends { title: string }>(text: string, tours: T[]): T | null {
  if (tours.length < 2) return null;
  const stems = (text.toLowerCase().match(/[а-яё]{5,}/g) ?? []).map((w) => w.slice(0, 4));
  let pool = tours.filter((t) => stems.some((st) => t.title.toLowerCase().includes(st)));
  const scored = pool.map((t) => ({ t, n: stems.filter((st) => t.title.toLowerCase().includes(st)).length }));
  const best = Math.max(0, ...scored.map((x) => x.n));
  pool = scored.filter((x) => x.n === best).map((x) => x.t);
  const dm = /\b(\d{1,2})\.(\d{1,2})\b/.exec(text);
  if (pool.length > 1 && dm) {
    const m = Number(dm[2]);
    if (m >= 1 && m <= 12) {
      const re = new RegExp(MONTH_STEMS[m - 1], 'i');
      const byMonth = pool.filter((t) => re.test(t.title));
      if (byMonth.length) pool = byMonth;
    }
  }
  return pool.length === 1 ? pool[0] : null;
}
