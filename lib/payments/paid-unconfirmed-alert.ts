/**
 * lib/payments/paid-unconfirmed-alert.ts — деньги пришли на бронь, которую
 * нельзя было платить (04.10).
 *
 * Обычно до этого не доходит: Check CloudPayments (/api/payments/check)
 * отклоняет такой платёж до списания. Дошло — значит Check не настроен в
 * кабинете или бронь сменила статус между Check и Pay. Приёмник записывает
 * факт оплаты, бронь не подтверждает, комиссию не начисляет; решение —
 * подтвердить бронь или вернуть деньги — за человеком. Отсюда — строка в лог
 * и тревога владельцу. Персональных данных в тревоге нет: номер брони и сумма.
 *
 * Одна функция на оба приёмника CloudPayments — копии уже расходились.
 */
import { tgSend } from '@/lib/notifications/tg-send';
import { escapeHtml } from '@/lib/text/escape-html';

export async function reportPaidUnconfirmed(
  scope: string,
  bookingId: string | number | bigint,
  status: string | null,
  amount: number,
): Promise<void> {
  console.error(`[${scope}] оплата пришла на бронь, которую нельзя было платить:`,
    `booking=${String(bookingId)}`, `status=${status ?? 'нет'}`);
  const out = await tgSend(scope, [
    '<b>CloudPayments: деньги пришли на неподтверждённую бронь</b>',
    '',
    `Бронирование: #${escapeHtml(String(bookingId))}`,
    `Статус брони: ${escapeHtml(status ?? 'не записан')}`,
    `Оплачено: ${Number(amount).toLocaleString('ru-RU')} р.`,
    '',
    'Факт оплаты записан, статус брони не менялся, комиссия не начислена.',
    'Решение — подтвердить бронь или вернуть деньги — за человеком.',
    'Если такое повторяется — проверьте, что Check-уведомление CloudPayments указывает на /api/payments/check.',
  ].join('\n'));
  if (!out.ok) console.error(`[${scope}] тревога владельцу не ушла:`, out.reason);
}
