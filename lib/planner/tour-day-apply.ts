/**
 * lib/planner/tour-day-apply.ts — места и цена тура, перечитанные на новую
 * дату дня, — в день плана на экране (разбор 14.11, смета-5).
 *
 * Перестановка дней на экране (`renumberByPosition`) снимает с дня, сменившего
 * дату, места, прогноз и цену прежней даты и ставит «цену ещё не перечитали»
 * (`TOUR_PRICE_PENDING_TEXT`). Экран спрашивает `GET /api/planner/tours-for-day`
 * с `tour_id` — тот же `rereadTourDay`, что у правки через Кузьмича
 * (plan-edit, `rereadTours`), — и кладёт ответ сюда. Правило полей одно с
 * правкой: что перечитано, то и стоит; чего нет в ответе — снято.
 *
 * Чистый модуль: его зовёт клиент, базу он не трогает.
 */
import { TOUR_PRICE_PENDING_TEXT } from './calendar-days';
import { PRICE_UNREAD_TEXT } from './price-unread';

/** Поля дня с туром, которые зависят от даты и группы (ответ `rereadTourDay`). */
export interface TourDayRead {
  availability: 'open' | 'none' | 'unread';
  /**
   * Когда прочитана занятость (ISO). Нет — не прочиталась: «проверено …»
   * прежнего чтения на дне не остаётся (разбор 14.11, Кузьмич-10).
   */
  checkedAt?: string;
  availableDate?: string;
  slotsRemaining?: number;
  capacityWarning?: string;
  realPrice?: number;
  priceLabel?: string;
  priceMissing?: string;
  priceFrom: number;
  priceTo: number;
}

export interface TourDayLike {
  day: number;
  priceFrom: number;
  priceTo: number;
  realPrice?: number;
  priceMissing?: string;
  availability?: 'open' | 'none' | 'unread';
  availabilityCheckedAt?: string;
  availableDate?: string;
  slotsRemaining?: number;
  capacityWarning?: string;
  realTour?: { tourId: string; priceLabel?: string; maxParticipants?: number };
}

/** День ждёт перечитывания цены после перестановки. */
export function awaitsTourReread(d: TourDayLike): boolean {
  return !!d.realTour && d.priceMissing === TOUR_PRICE_PENDING_TEXT;
}

/**
 * Ответ роута — в день. Применяется, только если на этом месте всё ещё тот
 * же тур и он всё ещё ждёт (ответ запоздал, а день снова переставили, —
 * чужой ответ не ложится). `read === null` — роут не ответил: цена «проверить
 * не удалось», места — «не прочитали».
 */
export function applyTourDayRead<T extends TourDayLike>(d: T, tourId: string, read: TourDayRead | null): T {
  if (!awaitsTourReread(d) || d.realTour?.tourId !== tourId) return d;
  const next = { ...d, realTour: { ...d.realTour } } as T;
  delete next.availableDate;
  delete next.availabilityCheckedAt;
  delete next.slotsRemaining;
  delete next.capacityWarning;
  delete next.realPrice;
  delete next.priceMissing;
  delete next.realTour!.priceLabel;
  if (read === null) {
    next.availability = 'unread';
    next.priceMissing = PRICE_UNREAD_TEXT;
    return next;
  }
  next.availability = read.availability;
  if (read.checkedAt !== undefined) next.availabilityCheckedAt = read.checkedAt;
  next.priceFrom = read.priceFrom;
  next.priceTo = read.priceTo;
  if (read.availableDate !== undefined) next.availableDate = read.availableDate;
  if (read.slotsRemaining !== undefined) next.slotsRemaining = read.slotsRemaining;
  if (read.capacityWarning !== undefined) next.capacityWarning = read.capacityWarning;
  if (read.realPrice !== undefined) next.realPrice = read.realPrice;
  if (read.priceMissing !== undefined) next.priceMissing = read.priceMissing;
  if (read.priceLabel !== undefined) next.realTour!.priceLabel = read.priceLabel;
  // Роут не назвал ни цены, ни причины — это не «бесплатно».
  if (next.realPrice === undefined && next.priceMissing === undefined) next.priceMissing = PRICE_UNREAD_TEXT;
  return next;
}

/** Ответ роута — форма проверяется, иначе он считается неответом. */
export function parseTourDayRead(body: unknown): TourDayRead | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { success?: unknown; read?: unknown };
  if (b.success !== true || !b.read || typeof b.read !== 'object') return null;
  const r = b.read as Record<string, unknown>;
  if (r.availability !== 'open' && r.availability !== 'none' && r.availability !== 'unread') return null;
  if (typeof r.priceFrom !== 'number' || typeof r.priceTo !== 'number') return null;
  const out: TourDayRead = { availability: r.availability, priceFrom: r.priceFrom, priceTo: r.priceTo };
  if (typeof r.checkedAt === 'string' && Number.isFinite(Date.parse(r.checkedAt))) out.checkedAt = r.checkedAt;
  if (typeof r.availableDate === 'string') out.availableDate = r.availableDate;
  if (typeof r.slotsRemaining === 'number') out.slotsRemaining = r.slotsRemaining;
  if (typeof r.capacityWarning === 'string') out.capacityWarning = r.capacityWarning;
  if (typeof r.realPrice === 'number' && r.realPrice > 0) out.realPrice = r.realPrice;
  if (typeof r.priceMissing === 'string') out.priceMissing = r.priceMissing;
  if (typeof r.priceLabel === 'string') out.priceLabel = r.priceLabel;
  return out;
}
