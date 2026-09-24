/**
 * lib/bookings/success-view.ts — что показывает страница после заявки
 * (`/booking-success/[id]`). Чистые правила, вынесены из компонента, чтобы их
 * держал сторож, а не глаз (tests/unit/booking-success-page.test.tsx).
 */

/**
 * Статусы брони, при которых туристу открывается оплата.
 *
 * Решение владельца 24.09 (аудит П3, развилка 4): оплата — только после
 * подтверждения оператором. Карточка тура обещает «Дату и детали
 * подтверждает оператор — оплата только после подтверждения», а до этой
 * правки новая заявка ('new', её ставит reserve.ts) сразу получала крупную
 * «Перейти к оплате». Платить за непроверенную дату — обещание, нарушенное
 * деньгами.
 */
export const PAYABLE_BOOKING_STATUSES: readonly string[] = ['confirmed', 'pending_payment'];

export function canOfferPayment(status: string | null | undefined): boolean {
  return typeof status === 'string' && PAYABLE_BOOKING_STATUSES.includes(status);
}

/**
 * Есть ли у оператора контакты, которые страница реально нарисует.
 * Текст «по его контактам ниже» допустим только при `true` — до 24.09 фраза
 * стояла всегда, а блок контактов рисовался лишь при телефоне или Telegram,
 * и у тура без контактов она обещала пустоту (#75/#87).
 */
export function hasOperatorContacts(b: {
  operator_phone: string | null;
  operator_telegram: string | null;
}): boolean {
  return Boolean(b.operator_phone?.trim() || b.operator_telegram?.trim());
}

/**
 * Заголовок и подзаголовок страницы по состоянию брони.
 *
 * Страница открывается из письма и ваучера на ЛЮБОМ этапе жизни брони, в том
 * числе после отмены. До доработки П3 (24.09) последняя ветка цепочки
 * отвечала «Оператор подтвердил заявку — … переходите к оплате» за всё, что
 * не 'new' и не оплачено: у отменённой и завершённой брони страница
 * утверждала подтверждение и звала платить, а блока оплаты не было (§4.0 —
 * пробел заполнялся неправдой). Теперь «подтвердил» — только когда оплата
 * действительно предлагается (`needsPayment`), у отмены и завершения — свои
 * слова, а неизвестный статус получает нейтральный заголовок без
 * подзаголовка: «не знаю» честнее угаданного.
 */
export type SuccessHeadline = {
  title: string;
  subtitle: string | null;
  tone: 'paid' | 'created' | 'cancelled' | 'neutral';
};

export function successHeadline(s: {
  status: string | null | undefined;
  alreadyPaid: boolean;
  needsPayment: boolean;
  noPayWay: boolean;
}): SuccessHeadline {
  if (s.status === 'cancelled') {
    return {
      title: 'Заявка отменена',
      subtitle: s.alreadyPaid
        ? 'Бронь отменена. Возврат оплаты оформляет администратор платформы — оплачивать ничего не нужно.'
        : 'Бронь отменена — оплачивать ничего не нужно.',
      tone: 'cancelled',
    };
  }
  if (s.status === 'completed') {
    return { title: 'Поездка состоялась', subtitle: 'Эта бронь завершена.', tone: 'neutral' };
  }
  if (s.alreadyPaid) {
    return {
      title: 'Оплата получена',
      subtitle: 'Мы передали оператору отметку об оплате — он подтвердит дальнейшие детали поездки.',
      tone: 'paid',
    };
  }
  if (s.status === 'new') {
    return {
      title: 'Заявка создана',
      subtitle: 'Мы передали заявку оператору. Он подтвердит дату — оплата откроется только после этого.',
      tone: 'created',
    };
  }
  if (s.needsPayment) {
    return {
      title: 'Заявка создана',
      subtitle: s.noPayWay
        ? 'Оператор подтвердил заявку. Как оплатить, он подскажет сам.'
        : 'Оператор подтвердил заявку — проверьте данные и переходите к оплате.',
      tone: 'created',
    };
  }
  return { title: 'Ваша заявка', subtitle: null, tone: 'neutral' };
}
