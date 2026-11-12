/**
 * Причины отказа продавца по заявке (решение владельца 02.11: отказ —
 * отдельный статус с причиной). Один список на кнопки чата
 * (lib/requests/chat-answer-buttons) и на «Отказ» в кабинете на сайте
 * (lib/leads/lost-reason).
 *
 * Модуль без базы, сети и подписи кнопок — его импортируют и клиентские экраны.
 */
export const DECLINE_REASONS = ['seats', 'weather', 'dates', 'group', 'other'] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

export const DECLINE_REASON_LABEL: Record<DeclineReason, string> = {
  seats: 'Нет мест',
  weather: 'Погода, безопасность',
  dates: 'Даты не подходят',
  group: 'Не подходит группа',
  other: 'Другое',
};

export function isDeclineReason(v: unknown): v is DeclineReason {
  return typeof v === 'string' && (DECLINE_REASONS as readonly string[]).includes(v);
}
