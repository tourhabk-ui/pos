/**
 * Оплаты на платформе стартуют не раньше 1 марта 2027 (решение владельца).
 * До этой даты в кабинете оператора не показываем выплаты, реквизиты,
 * выручку и суммы в ₽ — чтобы не обещать то, чего ещё нет.
 */
export const PAYMENTS_START = new Date('2027-03-01T00:00:00+12:00');

export function paymentsOpen(now: Date = new Date()): boolean {
  return now.getTime() >= PAYMENTS_START.getTime();
}
