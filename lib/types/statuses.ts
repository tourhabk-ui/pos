/**
 * Единый источник истины по статусам доменных сущностей.
 *
 * Урок прохода по админке (#91): три бага одного класса — клиент выдумывал
 * свои статусы вместо реальных из БД (фильтр «pending» у броней, которого
 * нет; краш карточки лида на AI-статусах). Клиенты и API импортируют списки
 * отсюда — разъехаться физически не могут.
 */

/** operator_bookings.booking_status — реальные значения в БД. */
export const BOOKING_STATUSES = [
  'new',
  'confirmed',
  'pending_payment',
  'completed',
  'cancelled',
  'rejected',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** leads.status — полный набор, включая статусы AI Lead Processor. */
export const LEAD_STATUSES = [
  'new',
  'contacted',
  'qualified',
  'converted',
  'lost',
  'ai_processing',
  'ai_qualified',
  'proposal_sent',
  'awaiting_confirm',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * Лид, которого ещё не взял ЧЕЛОВЕК: пришёл (`new`), разбирается конвейером
 * (`ai_processing`) или разобран конвейером (`ai_qualified`). Всё прочее —
 * след действия оператора/админа: предложение отправлено, клиент ждёт
 * подтверждения, связались, закрыт.
 *
 * Watchdog «лид без ответа > 2 ч» считал только `new`, а конвейер переводит
 * лид в `ai_qualified` за секунды после создания — то есть сторож не видел
 * почти ни одного лида, которого никто из людей не открыл. Разбор ИИ — не
 * ответ человеку. Сторож: tests/unit/watchdog-unattended-leads.test.ts.
 */
export const UNATTENDED_LEAD_STATUSES: readonly LeadStatus[] = [
  'new',
  'ai_processing',
  'ai_qualified',
];

/** Статусы, которые админ назначает руками (AI-статусы ставит конвейер). */
export const MANUAL_LEAD_STATUSES: LeadStatus[] = [
  'new', 'contacted', 'qualified', 'converted', 'lost',
];
