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
 * Тело уведомления: CloudPayments шлёт его формой (по умолчанию) или JSON
 * (если так настроено в кабинете). Подпись считается по сырому телу, поэтому
 * разбор — после проверки подписи и не меняет байты.
 */
export function parseCheckBody(raw: string): { invoiceId: string; amount: number } | null {
  let invoice: unknown;
  let amount: unknown;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as Record<string, unknown>;
      invoice = j.InvoiceId;
      amount = j.Amount;
    } catch {
      return null;
    }
  } else {
    const p = new URLSearchParams(trimmed);
    invoice = p.get('InvoiceId');
    amount = p.get('Amount');
  }
  const invoiceId = typeof invoice === 'number' ? String(invoice) : typeof invoice === 'string' ? invoice.trim() : '';
  const sum = typeof amount === 'number' ? amount : Number(amount);
  if (!invoiceId || !Number.isFinite(sum)) return null;
  return { invoiceId, amount: sum };
}
