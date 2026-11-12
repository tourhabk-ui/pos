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
 */

export const CHANGE_REQUEST_TOOL_NAME = 'change_request';

/**
 * Правило отмены и переноса — словами для агента, один текст на llms.txt и
 * страницу /mcp. Описание самого инструмента говорит то же подробнее
 * (lib/mcp/public-tools); сторож связки — tests/unit/mcp-change-request.test.ts.
 */
export const CHANGE_REQUEST_RULE =
  'Отменить заявку на тур или перенести её на другую дату — change_request по ключу, который create_booking_request выдал при создании заявки, '
  + 'и только по просьбе человека. Оператор ещё не ответил — заявка отменяется или дата меняется сразу; уже ответил, есть бронь или договорённость — '
  + 'ему уходит просьба, заявка и бронь не меняются. Отменённую заявку вернуть нельзя.';

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
}

export const CHANGE_REQUEST_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...CHANGE_ACTIONS], description: 'Что просили: cancel — отмена, change_date — перенос' },
    outcome: {
      type: 'string',
      enum: [...CHANGE_OUTCOMES],
      description: 'Исход одним словом. cancelled — заявка отменена; cancel_requested — отменяет оператор, просьба передана (оператору или менеджеру Ведара), заявка действует; '
        + 'cancel_request_undelivered — просьба никому не дошла, заявка действует, вызов можно повторить; date_changed — дата в заявке изменена; '
        + 'date_change_requested — дату меняет оператор, просьба ему отправлена; date_change_request_undelivered — просьба оператору не дошла; '
        + 'no_seats — на дату нет мест на число людей заявки; no_schedule — у тура нет расписания; daily_limit — за сутки по заявке уже три переноса или просьбы; '
        + 'date_refused_by_operator — на эту дату оператор уже ответил «Нет мест»; closed, past, no_data — менять нечего; would_* — ответ пробного вызова',
    },
    changed: { type: 'boolean', description: 'true — заявка изменена этим вызовом (отменена или стоит новая дата). Просьба оператору заявку не меняет' },
    test: { type: 'boolean', description: 'true — пробный вызов: ничего не записано и никому не отправлено' },
    human: { type: 'string', description: 'Что сказать человеку' },
    next: { type: 'string', description: 'Что делать дальше' },
    told: {
      type: ['string', 'null'],
      enum: [...CHANGE_TOLD, null],
      description: 'Кто узнал на деле: operator — оператору ушло сообщение; manager — оператор не узнал, менеджер Ведара предупреждён; nobody — не узнал никто; null — сообщать было не о чем',
    },
    date: { type: ['string', 'null'], description: 'Действующая дата заявки после вызова, YYYY-MM-DD' },
  },
  required: ['action', 'outcome', 'changed', 'test', 'human', 'next', 'told', 'date'],
} as const;
