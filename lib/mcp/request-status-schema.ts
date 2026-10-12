/**
 * get_request_status — объявление инструмента без базы.
 *
 * Схему читает реестр (lib/mcp/public-tools), а реестр — страница /mcp,
 * собираемая на сборке без DATABASE_URL (урок пары search/fetch, 12.10).
 * Исполнение с SQL — в lib/mcp/request-status.
 */

export const REQUEST_STATUS_TOOL_NAME = 'get_request_status';

/** Ключ — base64url от 24 случайных байт (32 знака); границы с запасом. */
export const REQUEST_KEY_MIN_CHARS = 20;
export const REQUEST_KEY_MAX_CHARS = 120;

/**
 * Состояния для агента. Не статусы базы, а то, что можно сказать человеку:
 * у лида и у запроса мест словари разные, здесь они сведены в один.
 */
export const REQUEST_STATES = [
  'awaiting_operator', 'operator_contacted', 'in_progress', 'confirmed',
  'declined', 'other_date', 'no_answer', 'cancelled', 'failed', 'unknown',
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const REQUEST_KINDS = ['lead', 'seat_request'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const GET_REQUEST_STATUS_TOOL = {
  name: REQUEST_STATUS_TOOL_NAME,
  description:
    'Состояние заявки, отправленной через create_lead, create_booking_request или request_charter, по ключу статуса из ответа того инструмента: '
    + 'ждёт оператора, оператор связался, подтверждена, отказ, другая дата, нет ответа. Без имени и телефона. '
    + 'Ключ выдаётся на каждую заявку и живёт 90 дней; без ключа состояние не узнать — номера заявок не называются. '
    + 'В ответе есть page — страница заявки для человека: там он сам подтверждает согласие на обработку данных и видит ответ оператора.',
  inputSchema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: `Ключ статуса из ответа пишущего инструмента, как есть (${REQUEST_KEY_MIN_CHARS}–${REQUEST_KEY_MAX_CHARS} знаков).`,
      },
    },
    required: ['key'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      state: { type: 'string', enum: [...REQUEST_STATES], description: 'Состояние заявки одним словом' },
      kind: { type: 'string', enum: [...REQUEST_KINDS], description: 'lead — заявка менеджеру или оператору; seat_request — запрос мест у оператора' },
      tour: { type: ['string', 'null'], description: 'Название тура, если заявка про тур' },
      date: { type: ['string', 'null'], description: 'Дата тура YYYY-MM-DD, если есть' },
      participants: { type: ['integer', 'null'], description: 'Число человек в заявке, если записано' },
      alt_date: { type: ['string', 'null'], description: 'Дата, которую предложил оператор вместо запрошенной' },
      deadline: { type: ['string', 'null'], description: 'До какого времени ждём ответ оператора (ISO 8601), у запроса мест' },
      human: { type: 'string', description: 'Состояние словами для человека' },
      next: { type: 'string', description: 'Что делать дальше' },
      consent: { type: 'string', enum: ['human', 'agent', 'none'], description: 'Чьё согласие на обработку персональных данных записано: human — человек подтвердил сам (страница заявки или форма сайта); agent — передал агент при создании; none — не записано' },
      page: { type: 'string', description: 'Страница заявки для человека: состояние, ответ оператора и подтверждение согласия своей рукой. Дайте её человеку, не публикуйте.' },
    },
    required: ['state', 'kind', 'human', 'next', 'consent', 'page'],
  },
} as const;
