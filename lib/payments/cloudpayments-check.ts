/**
 * lib/payments/cloudpayments-check.ts — решение на Check-уведомление
 * CloudPayments: принимать ли платёж ДО списания денег.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Платится бронь, подтверждённая оператором (решение владельца 24.09). У QR
 * СБП это держит сервер (`/api/payments/tochka/qr` отвечает `not_confirmed`),
 * а у CloudPayments — только страница брони: виджет рисуется при
 * `canOfferPayment`. Кто откроет виджет мимо страницы (номер брони — целое,
 * перебирается), тот заплатит за неподтверждённую заявку, и до 04.10 приёмник
 * Pay сам переводил её в `confirmed` — оплата подменяла согласие оператора.
 *
 * Check приходит от CloudPayments до списания: ответ `{ code: 0 }` — платёж
 * идёт дальше, любой другой код — банк его отклоняет, деньги не трогаются.
 * Поэтому здесь отказ безопаснее согласия: «не смог проверить» — тоже отказ.
 *
 * Коды — из протокола CloudPayments: 10 — неверный номер заказа, 12 —
 * неверная сумма, 13 — платёж не может быть принят.
 */
import { canOfferPayment } from '@/lib/bookings/success-view';
import { parseCloudPaymentsBody } from '@/lib/payments/cloudpayments-body';

export type CloudPaymentsCheckCode = 0 | 10 | 12 | 13;

export interface CheckBookingRow {
  booking_status: string | null;
  payment_status: string | null;
  paid_at: Date | string | null;
  final_price: string | number;
  deleted: boolean;
}

/** Допуск по сумме — тот же рубль, что у приёмников (amountMatches). */
const AMOUNT_TOLERANCE = 1;

export function decideCloudPaymentsCheck(
  row: CheckBookingRow | null,
  amount: number,
): { code: CloudPaymentsCheckCode; reason: string } {
  if (!row || row.deleted) return { code: 10, reason: 'бронь не найдена' };
  if (row.paid_at || row.payment_status === 'paid') return { code: 13, reason: 'бронь уже оплачена' };
  if (!canOfferPayment(row.booking_status)) {
    return { code: 13, reason: `оператор ещё не подтвердил бронь (статус ${row.booking_status ?? 'не записан'})` };
  }
  const expected = Number(row.final_price);
  if (!Number.isFinite(expected) || !Number.isFinite(amount) || Math.abs(expected - amount) > AMOUNT_TOLERANCE) {
    return { code: 12, reason: `сумма не совпала с бронью: ждали ${row.final_price}, пришло ${amount}` };
  }
  return { code: 0, reason: 'бронь подтверждена оператором, сумма совпала' };
}

/**
 * Тело уведомления: форма или JSON — один разбор с Pay (lib/payments/cloudpayments-body).
 */
export function parseCheckBody(raw: string): { invoiceId: string; amount: number } | null {
  const fields = parseCloudPaymentsBody(raw);
  if (!fields) return null;
  const invoice = fields.InvoiceId;
  const amount = fields.Amount;
  const invoiceId = typeof invoice === 'number' ? String(invoice) : typeof invoice === 'string' ? invoice.trim() : '';
  const sum = typeof amount === 'number' ? amount : Number(amount);
  if (!invoiceId || !Number.isFinite(sum)) return null;
  return { invoiceId, amount: sum };
}
