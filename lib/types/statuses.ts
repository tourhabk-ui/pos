/**
 * Единый источник истины по статусам доменных сущностей.
 *
 * Урок прохода по админке (#91): три бага одного класса — клиент выдумывал
 * свои статусы вместо реальных из БД (фильтр «pending» у броней, которого
 * нет; краш карточки лида на AI-статусах). Клиенты и API импортируют списки
 * отсюда — разъехаться физически не могут.
 */

/**
 * operator_bookings.booking_status — ЕДИНЫЙ словарь (аудит 15.10, A11).
 *
 * До этой правки словарей было два, и они расходились: здесь стоял `rejected`
 * без `no_show`, в `types/booking.types.ts` — `no_show` без `rejected`.
 * Админка фильтровала по одному, переходы статусов строились по другому.
 * Теперь `types/booking.types.ts` берёт и тип, и список отсюда.
 *
 * Состав — по производителю (правило 10.09): Zod-схема ручной правки статуса
 * оператором (`app/api/hub/operator/bookings/[id]/route.ts`, она и ставит
 * `no_show`), создание брони (`lib/bookings/reserve.ts`) и платёжный путь
 * (`pending_payment`). У `rejected` писателя нет — он остаётся только в
 * защитных WHERE (`FREEING_BOOKING_STATUSES` в lib/bookings/occupancy.ts), где
 * лишнее значение безвредно. Есть ли на проде строки вне словаря — отвечает
 * перепись `GET /api/cron/booking-status-census`.
 *
 * CHECK на колонку стоит по этому словарю (аудит 15.10, BOOKING-CHECK:
 * миграция operator_bookings_status_check, после замера переписи). Новое
 * слово сюда — только вместе с миграцией, переставляющей
 * `operator_bookings_booking_status_check`; иначе писатель получит 23514.
 * Сторож связки: tests/unit/booking-status-check.test.ts.
 */
export const BOOKING_STATUSES = [
  'new',
  'confirmed',
  'pending_payment',
  'completed',
  'cancelled',
  'no_show',
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
