/**
 * Последний день тура по брони — одно правило для автозавершения (на
 * следующий день после него) и для окна просьбы об отзыве (13.10).
 *
 * end_date брони; нет его — дата брони плюс длительность брони или тура
 * (duration_days, multi_day_count) минус один день; нет и их — сама дата
 * брони. Алиасы в запросе: бронь — `ob`, тур — `ot`.
 *
 * SQL проверен на PostgreSQL 16 (tests/unit/booking-auto-complete.test.ts).
 */
export const TOUR_LAST_DAY_SQL =
  'COALESCE(ob.end_date, ob.booking_date + (GREATEST(COALESCE(ob.duration_days, ot.multi_day_count, 1), 1) - 1))';
