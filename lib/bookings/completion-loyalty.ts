/**
 * Баллы лояльности за завершённый тур — одно место для кнопки «Завершить»
 * (app/api/bookings/[id]/complete) и автоматического завершения на следующий
 * день после тура (lib/bookings/auto-complete-past, решение владельца 13.10).
 *
 * До 13.10 эти два вызова стояли прямо в роуте; второй путь завершения без
 * общего места начислял бы иначе или не начислял вовсе. Fire-and-forget, как
 * было: баллы не должны ронять завершение, но отказ называется в логе.
 */

import { loyaltySystem } from '@/lib/loyalty/loyalty-system';
import { logText } from '@/lib/log/log-text';
import type { BookingWithDetails } from '@/types/booking.types';

function logFailure(what: string, err: unknown): void {
  console.error(`[completion-loyalty] ${what}:`, logText(err instanceof Error ? err.message : err, 200));
}

export function awardCompletionLoyalty(booking: BookingWithDetails, bookingId: string): void {
  if (!booking.tourist?.id || !(booking.totalAmount > 0)) return;
  loyaltySystem.earnPoints(booking.tourist.id, bookingId, booking.totalAmount)
    .catch((err: unknown) => logFailure('баллы за тур не начислены', err));
  // Бонус «Первое бронирование» (+100) — обещан в UI лояльности; внутри свой
  // дедуп-гард: начислится ровно один раз.
  loyaltySystem.earnActivityPoints(booking.tourist.id, 'first_booking', bookingId)
    .catch((err: unknown) => logFailure('бонус первого бронирования не начислен', err));
}
