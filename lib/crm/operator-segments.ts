/**
 * lib/crm/operator-segments.ts — сегменты клиентов оператора словами и числами
 * (CRM #2325, шаг 1а-2b). Без пула и без сервера: это читают и запрос
 * (`lib/crm/operator-clients.ts`), и выгрузка, и экран в браузере — одно
 * правило и одни слова на всех.
 */

export const OPERATOR_SEGMENTS = ['vip', 'active', 'inactive', 'none'] as const;
export type OperatorSegment = (typeof OPERATOR_SEGMENTS)[number];

export const OPERATOR_SORTS = ['recent', 'sum', 'bookings'] as const;
export type OperatorSort = (typeof OPERATOR_SORTS)[number];

/** Правило сегмента — те же пороги, что у прежнего экрана «Клиенты» оператора. */
export const VIP_MIN_BOOKINGS = 3;
export const VIP_MIN_SUM_RUB = 100_000;
export const ACTIVE_DAYS = 90;

export const OPERATOR_SEGMENT_LABELS: Readonly<Record<OperatorSegment, string>> = {
  vip: 'VIP',
  active: 'Активный',
  inactive: 'Неактивный',
  none: 'Без броней',
};

export const OPERATOR_SORT_LABELS: Readonly<Record<OperatorSort, string>> = {
  recent: 'Последнее обращение',
  sum: 'Сумма броней',
  bookings: 'Число броней',
};

/** Как сегмент выбирается — словами, для подсказки на экране. */
export const OPERATOR_SEGMENT_RULE =
  `VIP — от ${VIP_MIN_BOOKINGS} броней или от ${VIP_MIN_SUM_RUB.toLocaleString('ru-RU')} ₽ подтверждённых броней; ` +
  `активный — бронь за последние ${ACTIVE_DAYS} дней; отменённые брони не считаются.`;
