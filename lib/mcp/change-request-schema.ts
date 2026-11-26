/**
 * change_request — объявление без базы: имя, действия, исходы и схема ответа.
 *
 * Схему читает реестр (lib/mcp/public-tools), а реестр — страница /mcp,
 * собираемая на сборке без DATABASE_URL. Исполнение с SQL — в
 * lib/mcp/change-request.
 *
 * Слово владельца 11.11: «мы доверяем агенту»; заявку можно отменить и
 * перенести «как самим человеком», а что будет — «зависит от ответа»: адресат
 * ещё не ответил — сразу, уже ответил — просьбой ему. Правило одно на чат
 * «Моей поездки» и на этот инструмент: lib/requests/cancel-request и
 * lib/requests/my-trip-date.
 *
 * Слово владельца 20.11 «1 для всех агентов» (#3573, условия каталога плагинов
 * Алисы): вызов агента заявку сам не меняет. Он проверяет, что произошло бы,
 * и отдаёт ссылку на страницу Ведара (/confirm/change); отменяет или переносит
 * заявку только нажатие человека там — тем же правилом, что выше.
 */

export const CHANGE_REQUEST_TOOL_NAME = 'change_request';

/**
 * Правило отмены и переноса — словами для агента, один текст на llms.txt и
 * страницу /mcp. Описание самого инструмента говорит то же подробнее
 * (lib/mcp/public-tools); сторож связки — tests/unit/mcp-change-request.test.ts.
 */
export const CHANGE_REQUEST_RULE =
  'Отменить заявку на тур или перенести её на другую дату — change_request по ключу, который create_booking_request выдал при создании заявки, '
  + 'и только по просьбе человека. Вызов заявку не меняет: ответ даёт ссылку на страницу Ведара, где человек подтверждает отмену или перенос сам. '
  + 'После подтверждения: оператор ещё не ответил — заявка отменяется или дата меняется сразу; уже ответил, есть бронь или договорённость — '
  + 'ему уходит просьба, заявка и бронь не меняются. Отменённую заявку вернуть нельзя. Заявка — не бронь.';

export const CHANGE_ACTIONS = ['cancel', 'change_date'] as const;
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

/**
 * Чем кончился вызов — одним словом. Проба (`test: true`) отвечает своими
 * словами `would_*`: агент, прочитавший у пробы `cancelled`, сказал бы
 * человеку «отменено», а заявка стоит.
 */
export const CHANGE_OUTCOMES = [
  // Отмена.
  'cancelled', 'cancel_requested', 'cancel_request_undelivered', 'already_cancelled', 'cancel_already_requested',
  // Перенос.
  'date_changed', 'date_change_requested', 'date_change_request_undelivered',
  'same_date', 'date_refused_by_operator', 'no_seats', 'no_schedule', 'daily_limit', 'changed_elsewhere',
  // Заявку менять поздно или не по чему.
  'closed', 'past', 'no_data',
  // Проба: что произошло бы.
  'would_cancel', 'would_request_cancel', 'would_change_date', 'would_request_date_change',
  // Вызов агента: заявка не изменена, подтверждает человек по ссылке (20.11).
  'confirm_on_page',
] as const;
export type ChangeOutcome = (typeof CHANGE_OUTCOMES)[number];

/** Кто узнал об изменении на деле: оператор, только менеджер Ведара, никто; null — сообщать было не о чем. */
export const CHANGE_TOLD = ['operator', 'manager', 'nobody'] as const;
export type ChangeTold = (typeof CHANGE_TOLD)[number];

export interface ChangeRequestResult {
  action: ChangeAction;
  outcome: ChangeOutcome;
  /** Изменилась ли заявка этим вызовом: статус или дата. Просьба оператору заявку не меняет. */
  changed: boolean;
  /** Пробный вызов: ничего не записано и никому не отправлено. */
  test: boolean;
  /** Что сказать человеку. */
  human: string;
  /** Что делать дальше — агенту. */
  next: string;
  told: ChangeTold | null;
  /** Действующая дата заявки после вызова, YYYY-MM-DD; null — не записана. */
  date: string | null;
  /** Ссылка, где человек подтверждает отмену или перенос сам; null — подтверждать нечего. */
  confirm_url: string | null;
}

export const CHANGE_REQUEST_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...CHANGE_ACTIONS], description: 'Requested: cancel or change_date' },
    outcome: {
      type: 'string',
      enum: [...CHANGE_OUTCOMES],
      description: 'One-word outcome. cancelled; cancel_requested — the operator cancels, request passed on, the request stands; '
        + 'cancel_request_undelivered — reached nobody, the request stands, retry; date_changed; date_change_requested — the operator decides; '
        + 'date_change_request_undelivered; no_seats — not enough seats on that date; no_schedule; daily_limit — three moves or requests today; '
        + 'date_refused_by_operator — operator already said no seats; closed, past, no_data — nothing to change; would_* — dry run; '
        + 'confirm_on_page — unchanged: the person confirms via confirm_url',
    },
    changed: { type: 'boolean', description: 'true — this call changed the request; a request to the operator does not' },
    test: { type: 'boolean', description: 'true — dry run: nothing stored or sent' },
    human: { type: 'string', description: 'What to tell the person' },
    next: { type: 'string', description: 'What to do next' },
    told: {
      type: ['string', 'null'],
      enum: [...CHANGE_TOLD, null],
      description: 'Who was actually told: operator; manager (operator not reached); nobody; null — nothing to tell',
    },
    date: { type: ['string', 'null'], description: 'Current request date after the call, YYYY-MM-DD' },
    confirm_url: {
      type: ['string', 'null'],
      description: 'Vedar page where the person confirms; give it as is. null — nothing to confirm',
    },
  },
  required: ['action', 'outcome', 'changed', 'test', 'human', 'next', 'told', 'date', 'confirm_url'],
} as const;
