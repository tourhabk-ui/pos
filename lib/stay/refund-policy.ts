/**
 * lib/stay/refund-policy.ts
 *
 * Политика возврата при отмене брони жилья. Зеркало тур-политики
 * (lib/bookings/booking.service.ts calculateRefund), формулировки под
 * «заезд». Физический возврат по CloudPayments — офлайн (живого refund-API
 * в коде нет; app/api/payments не трогаем, CLAUDE.md §7); здесь только
 * расчёт суммы для фиксации в accommodation_bookings и уведомления.
 *
 * Правила:
 * - Отмена владельцем/админом → всегда 100%.
 * - Отмена гостем: >48ч до заезда → 100%; 24–48ч → 50%; <24ч → 0%.
 */

export interface StayRefundResult {
  percent: number;
  amount: number;
  reason: string;
}

export function calculateStayRefund(
  totalPrice: number,
  checkInDate: Date,
  isOwnerCancel: boolean,
): StayRefundResult {
  const total = Number.isFinite(totalPrice) && totalPrice > 0 ? totalPrice : 0;

  if (isOwnerCancel) {
    return {
      percent: 100,
      amount: total,
      reason: 'Отмена со стороны объекта/администрации. Полный возврат.',
    };
  }

  const hoursUntilCheckIn = (checkInDate.getTime() - Date.now()) / (1000 * 60 * 60);

  if (hoursUntilCheckIn > 48) {
    return {
      percent: 100,
      amount: total,
      reason: 'Отмена более чем за 48 часов до заезда. Полный возврат.',
    };
  }

  if (hoursUntilCheckIn >= 24) {
    return {
      percent: 50,
      amount: Math.floor(total * 0.5),
      reason: 'Отмена за 24–48 часов до заезда. Возврат 50%.',
    };
  }

  return {
    percent: 0,
    amount: 0,
    reason: 'Отмена менее чем за 24 часа до заезда. Возврат не предусмотрен.',
  };
}
