/**
 * lib/payments/payment-anomaly-alert.ts — банк взял деньги, а приёмник их не
 * записал как оплату брони (#3433 п. 2, слово владельца 16.11).
 *
 * До этого такие случаи у CloudPayments уходили одной строкой в лог, а банк
 * получал «принято» и больше не спрашивал: деньги у платформы, следа нет
 * нигде, кроме лога, который никто не читает. У СБП Точки тревога была —
 * теперь одна функция на все приёмники.
 *
 * Виды:
 *   amount_mismatch — сумма не совпала с бронью; бронь не подтверждена;
 *   second_payment  — бронь уже оплачена ДРУГОЙ операцией: деньги взяты дважды;
 *   unmatched       — номер счёта не нашёлся ни в бронях, ни в платежах;
 *   refused_after_paid — отказ или отмена пришли по уже оплаченной брони:
 *                     бронь не тронута, но что с деньгами — решает человек.
 *
 * Решение — вернуть деньги или подтвердить — за человеком. ПД в тревоге нет:
 * номер брони, суммы, вид платёжной системы. Номер операции банка — тоже нет:
 * его видно в кабинете платёжной системы по номеру брони.
 */
import { tgSend } from '@/lib/notifications/tg-send';
import { escapeHtml } from '@/lib/text/escape-html';

export type PaymentAnomalyKind = 'amount_mismatch' | 'second_payment' | 'unmatched' | 'refused_after_paid';

const HEADLINE: Record<PaymentAnomalyKind, string> = {
  amount_mismatch: 'сумма оплаты не совпала с бронью — бронь НЕ подтверждена',
  second_payment: 'вторая оплата уже оплаченной брони — деньги взяты дважды',
  unmatched: 'оплата не сопоставлена ни с одной бронью',
  refused_after_paid: 'отказ или отмена платежа по уже оплаченной брони',
};

const ACTION: Record<PaymentAnomalyKind, string> = {
  amount_mismatch: 'Решение — вернуть деньги или подтвердить бронь вручную — за человеком.',
  second_payment: 'Первая оплата записана. Вторую нужно вернуть вручную.',
  unmatched: 'Найдите платёж в кабинете платёжной системы и решите, вернуть ли деньги.',
  refused_after_paid: 'Бронь и запись оплаты не менялись. Проверьте в кабинете платёжной системы, не возвращены ли деньги.',
};

export interface PaymentAnomaly {
  kind: PaymentAnomalyKind;
  /** Платёжная система: «CloudPayments», «СБП Точка». */
  provider: string;
  bookingId?: string | number | bigint | null;
  expected?: number | null;
  paid?: number | null;
}

/** Текст тревоги — без ПД. Отдельно, чтобы сторож судил то, что уйдёт. */
export function paymentAnomalyText(a: PaymentAnomaly): string {
  const money = (n: number) => `${Number(n).toLocaleString('ru-RU')} р.`;
  return [
    `<b>${escapeHtml(a.provider)}: ${HEADLINE[a.kind]}</b>`,
    '',
    a.bookingId != null ? `Бронирование: #${escapeHtml(String(a.bookingId))}` : null,
    a.expected != null ? `Ожидалось: ${money(a.expected)}` : null,
    a.paid != null ? `Оплачено: ${money(a.paid)}` : null,
    '',
    ACTION[a.kind],
  ].filter((l): l is string => l !== null).join('\n');
}

export async function reportPaymentAnomaly(scope: string, a: PaymentAnomaly): Promise<void> {
  console.error(`[${scope}] ${HEADLINE[a.kind]}:`,
    `booking=${a.bookingId != null ? String(a.bookingId) : 'нет'}`,
    `expected=${a.expected ?? 'нет'}`, `paid=${a.paid ?? 'нет'}`);
  // Тревога не роняет приёмник: запись оплаты уже решена, повтор уведомления
  // тревогу не вернёт — отказ называется в логе.
  try {
    const out = await tgSend(scope, paymentAnomalyText(a));
    if (!out.ok) console.error(`[${scope}] тревога владельцу не ушла:`, out.reason);
  } catch (err) {
    console.error(`[${scope}] тревога владельцу не ушла:`, err instanceof Error ? err.message : String(err));
  }
}
