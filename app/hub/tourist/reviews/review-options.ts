/**
 * Свои поездки → варианты для формы отзыва (экран «Мои отзывы»).
 *
 * Только те, где отзыв примет сервер: canReview из /api/bookings/my — то же
 * правило, что у POST /api/reviews/tour (бронь со статусом completed). Статус
 * для показа считает «не явился» завершённой поездкой, и до 13.10 форма
 * бралась по нему — сервер такой отзыв отклонял 403. Без повторов: несколько
 * броней одного тура — один вариант.
 *
 * Сторож: tests/unit/review-form-from-own-trips.test.ts.
 */

export interface TourOption {
  id: string;
  name: string;
}

export interface BookingForReview {
  status?: string;
  canReview?: boolean;
  tour?: { id?: string; name?: string };
}

export function reviewTourOptions(bookings: readonly BookingForReview[] | null | undefined): TourOption[] {
  const seen = new Set<string>();
  const out: TourOption[] = [];
  for (const b of bookings ?? []) {
    if (b?.canReview !== true) continue;
    const id = b.tour?.id;
    const name = b.tour?.name;
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out;
}
