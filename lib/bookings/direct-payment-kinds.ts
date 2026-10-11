/**
 * Оплата напрямую оператору — словарь и чистые расчёты (CRM фаза 2в).
 * Без пула и сервера: это читают и роуты, и карточка брони в браузере.
 * Запросы — в lib/bookings/direct-payments.ts.
 */

export const DIRECT_PAYMENT_METHODS = ['cash', 'transfer', 'card', 'other'] as const;
export type DirectPaymentMethod = (typeof DIRECT_PAYMENT_METHODS)[number];

export const DIRECT_PAYMENT_METHOD_LABELS: Readonly<Record<DirectPaymentMethod, string>> = {
  cash: 'наличными',
  transfer: 'переводом',
  card: 'картой через терминал',
  other: 'другим способом',
};

export interface DirectPaymentRow {
  id: string;
  amount: number;
  method: DirectPaymentMethod;
  received_on: string;
  note: string | null;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
}

/** Получено по действующим записям. Аннулированные не считаются. */
export function directPaidTotal(rows: ReadonlyArray<Pick<DirectPaymentRow, 'amount' | 'voided_at'>>): number {
  return Math.round(rows.reduce((s, r) => (r.voided_at ? s : s + Number(r.amount)), 0) * 100) / 100;
}

/**
 * Сколько осталось получить. null — цена брони не записана: «осталось»
 * неизвестно, а не ноль (§4.0).
 */
export function directRemaining(finalPrice: number | null, paid: number): number | null {
  if (finalPrice === null || !Number.isFinite(finalPrice)) return null;
  return Math.max(0, Math.round((finalPrice - paid) * 100) / 100);
}
