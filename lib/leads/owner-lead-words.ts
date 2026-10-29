/**
 * Слова заявки (лида) для того, кто продаёт тур сам: статусы, кнопки ответа
 * и исход повтора. Одни для раздела «Свои туры» гида и его кнопок в
 * мессенджере (план «гид в чате», шаг 7) — две копии слов разошлись бы.
 *
 * Модуль без базы и сети — его импортируют и клиентские экраны. Само правило
 * смены статуса — lib/leads/owner-lead-status.
 */

/**
 * Статусы, которые продавец своего тура ставит заявке сам. Остальные
 * (`ai_*`, `proposal_sent`, `awaiting_confirm`) ставит конвейер заявок
 * платформы, а не человек.
 */
export const OWNER_LEAD_STATUSES = ['contacted', 'qualified', 'converted', 'lost'] as const;
export type OwnerLeadStatus = (typeof OWNER_LEAD_STATUSES)[number];

/**
 * Заявка ждёт ответа продавца — тот же набор, что держит её во «Входящих»
 * (lib/crm/inbox-sql, вид `lead`).
 */
export const LEAD_WAITING_STATUSES = ['new', 'ai_qualified', 'awaiting_confirm'] as const;

export function leadIsWaiting(status: string | null | undefined): boolean {
  return (LEAD_WAITING_STATUSES as readonly string[]).includes(status ?? '');
}

/** Статус заявки словами для продавца. */
export const LEAD_STATUS_WORDS: Readonly<Record<string, string>> = {
  new: 'Новая — ждёт вашего ответа',
  ai_processing: 'Разбирается',
  ai_qualified: 'Разобрана — ждёт вашего ответа',
  proposal_sent: 'Предложение отправлено',
  awaiting_confirm: 'Ждёт вашего ответа',
  contacted: 'Вы связались',
  qualified: 'Обсуждаете детали',
  converted: 'Договорились',
  lost: 'Отказ',
};

/** Кнопки ответа на заявку. */
export const OWNER_LEAD_ACTION_LABEL: Readonly<Record<OwnerLeadStatus, string>> = {
  contacted: 'Связался',
  qualified: 'Обсуждаем',
  converted: 'Договорились',
  lost: 'Отказ',
};

/**
 * Какие отметки предложить: все, кроме той, что уже стоит. Перехода «нельзя»
 * у заявки нет — ни в кабинете оператора, ни здесь: отказ мог передумать.
 */
export function ownerLeadActionsFor(status: string | null | undefined): OwnerLeadStatus[] {
  return OWNER_LEAD_STATUSES.filter((s) => s !== status);
}

/** «Заявка уже отмечена: «Договорились».» — повтор не новое действие. */
export function leadAlreadyText(status: string): string {
  const word = LEAD_STATUS_WORDS[status] ?? status;
  return `Заявка уже отмечена: «${word}» — ничего не изменено.`;
}
