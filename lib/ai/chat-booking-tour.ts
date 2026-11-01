/**
 * Тур для формы брони в веб-чате — тем же резолвером, что у мессенджеров
 * (lib/kuzmich/core.ts: chooseSellerForBooking → chooseTourForBooking).
 * До 01.11 веб-чат брал tourSuggestions[0] — первое совпадение по слову, и
 * форма открывалась на туре другой компании, если в реплике назван продавец
 * или подходящих туров несколько. Теперь: один тур — форма на нём; несколько —
 * формы нет, человек выбирает карточку сам; отказ базы — не угадываем.
 */
import { extractTourKeywords } from '@/lib/kuzmich/core';
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
    return { tour: suggestions.length === 1 ? suggestions[0] : null, candidates: [] };
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
  return { tour: null, candidates: tours.map(candidateToSuggestion) };
}
