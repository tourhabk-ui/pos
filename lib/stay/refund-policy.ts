/**
 * lib/stay/refund-policy.ts
 *
 * Возврат при отмене брони жилья — 100%, как у туров (решение владельца
 * 11.09 для туров, распространено на жильё 24.09: «сделай отмену жилья
 * честной»).
 *
 * До 24.09 здесь стояла лестница 100/50/0% по часам до заезда — копия
 * calculateRefund, которую владелец снял 11.09. Она к тому же не читала
 * accommodations.cancellation_policy, а диалог отмены показывал гостю именно
 * текст объекта: соглашался гость с одним, считалось ему другое.
 *
 * Физического возврата по платёжному API здесь НЕТ (не подключён, §7): сумма
 * — то, что предстоит вернуть вручную. Отметку «возвращено» ставит ТОЛЬКО
 * администратор отдельным действием (PATCH /api/stay/bookings/[id],
 * refund_done), а не сама отмена и не владелец объекта.
 *
 * С 26.09 жильё оплачивается владельцу НА МЕСТЕ при заселении (решение
 * владельца): у новых броней предоплаты нет, и функция зовётся только для
 * старых броней, оплаченных через платформу (payment_status = 'paid').
 */

export interface StayRefundResult {
  percent: number;
  amount: number;
  reason: string;
}

export function calculateStayRefund(
  totalPrice: number,
  _checkInDate: Date,
  isOwnerCancel: boolean,
): StayRefundResult {
  const total = Number.isFinite(totalPrice) && totalPrice > 0 ? totalPrice : 0;
  return {
    percent: 100,
    amount: total,
    reason: isOwnerCancel
      ? 'Отмена со стороны объекта или администрации. Полный возврат.'
      : 'Отмена гостем. Полный возврат.',
  };
}
