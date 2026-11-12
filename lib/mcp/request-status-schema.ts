/**
 * get_request_status — объявление инструмента без базы.
 *
 * Схему читает реестр (lib/mcp/public-tools), а реестр — страница /mcp,
 * собираемая на сборке без DATABASE_URL (урок пары search/fetch, 12.10).
 * Исполнение с SQL — в lib/mcp/request-status.
 */

import type { PdConsentPurpose } from '@/lib/legal/pd-consent';

export const REQUEST_STATUS_TOOL_NAME = 'get_request_status';

/** Ключ — base64url от 24 случайных байт (32 знака); границы с запасом. */
export const REQUEST_KEY_MIN_CHARS = 20;
export const REQUEST_KEY_MAX_CHARS = 120;

/**
 * Состояния для агента. Не статусы базы, а то, что можно сказать человеку:
 * у лида, запроса мест и заявки на жильё словари разные, здесь они сведены
 * в один.
 *
 * `delivered` — заявка передана, и ответа платформа пока не видит. Так
 * устроена заявка на жильё (#2371, 14.10): владелец отвечает гостю звонком.
 * «Ждёт ответа» здесь было бы обещанием, которое может не сбыться: страница
 * переспрашивала бы вечно. С 1359 владелец отвечает и кнопкой — тогда
 * состояние говорит его ответ (`in_progress` или `declined`).
 *
 * `test` — пробная заявка (`test: true`, 08.11, lib/mcp/test-run): проверки
 * пройдены, но заявки нет — она не записана и никому не передана.
 */
export const REQUEST_STATES = [
  'awaiting_operator', 'delivered', 'operator_contacted', 'in_progress', 'confirmed',
  'declined', 'other_date', 'no_answer', 'cancelled', 'failed', 'unknown', 'test',
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const REQUEST_KINDS = ['lead', 'seat_request', 'stay_request'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/**
 * На передачу кому согласие по заявке — тот текст человек и подтверждает на
 * странице заявки (lib/legal/pd-consent, consentWording). Данные заявки на
 * жильё уходят владельцу, заявки на машину — перевозчику: согласие,
 * молчащее о получателе, их не покрывает.
 */
export const CONSENT_PURPOSES = ['operator', 'stay', 'carrier', 'rental'] as const satisfies readonly PdConsentPurpose[];
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/**
 * Кто отвечает по заявке — словами, в нужном падеже. Одна таблица на ответ
 * агенту (lib/mcp/request-status) и страницу заявки: до 11.11 у заявки на
 * машину и прокат обе говорили «оператор» и звали в каталог туров.
 */
export const ADDRESSEE_WORDS: Record<ConsentPurpose, { nom: string; gen: string; dat: string; ins: string }> = {
  operator: { nom: 'оператор', gen: 'оператора', dat: 'оператору', ins: 'оператором' },
  stay: { nom: 'владелец жилья', gen: 'владельца жилья', dat: 'владельцу жилья', ins: 'владельцем жилья' },
  carrier: { nom: 'перевозчик', gen: 'перевозчика', dat: 'перевозчику', ins: 'перевозчиком' },
  rental: { nom: 'прокатчик', gen: 'прокатчика', dat: 'прокатчику', ins: 'прокатчиком' },
};

/** Первая буква — заглавная: подлежащее в начале фразы. */
export function capitalized(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

// ── Подписка на уведомления (29.10, lib/mcp/request-notify-schema) ──────────
// Здесь, а не там: поле notify — часть ответа этого инструмента, а модуль
// уведомлений сам читает словари отсюда; две стороны цикла импорта не нужны.

/**
 * Что из причин отключения подписки (NOTIFY_DISABLED_REASONS в
 * lib/mcp/request-notify-schema, CHECK миграции 1348) видит агент. Грубо намеренно: исход доставки — не оракул
 * сканирования сети. «Адрес разрешился во внутренний» отдельным словом не
 * называется и отдельным графиком не отключается (критика безопасности
 * 29.10): по нему агент перебирал бы, во что резолвер прода разрешает имена.
 * `expired` агент не увидит никогда — срок подписки равен сроку ключа, а
 * истёкший ключ не читается вовсе.
 */
export const NOTIFY_PUBLIC_REASONS = ['gone', 'undeliverable', 'vedar_failure'] as const;
export type NotifyPublicReason = (typeof NOTIFY_PUBLIC_REASONS)[number];

export function publicDisabledReason(reason: string | null | undefined): NotifyPublicReason | null {
  switch (reason) {
    case null:
    case undefined:
      return null;
    case 'gone': return 'gone';
    case 'undecryptable': return 'vedar_failure';
    default: return 'undeliverable';
  }
}

/** Поле notify в ответе get_request_status. */
export const NOTIFY_STATUS_PROPERTY = {
  type: ['object', 'null'],
  description: 'Подписка на уведомления этой заявки: null — не заводилась (notify_url не передан) или удалена через 30 дней после отключения. active: false — уведомлений больше не будет, опрашивайте get_request_status; disabled_reason: gone — приёмник ответил 410; undeliverable — доставить не удалось (ответ 4xx или повторы исчерпаны; причина бывает и на пути до приёмника); vedar_failure — сбой на стороне Ведара',
  properties: {
    ref: { type: 'string' },
    active: { type: 'boolean' },
    disabled_reason: { type: ['string', 'null'], enum: [...NOTIFY_PUBLIC_REASONS, null] },
  },
  required: ['ref', 'active', 'disabled_reason'],
} as const;

export interface RequestNotifyStatus {
  ref: string;
  active: boolean;
  disabled_reason: NotifyPublicReason | null;
}

/**
 * Правило доставки ответа — словами для агента (план «после отказа», 2б;
 * слово владельца 11.11 «мы доверяем агенту»). Исполняет readRequestStatus
 * (lib/mcp/request-status): вид, построенный из ответа туроператора кнопкой
 * или из «Не могу» перевозчика и прокатчика (этап 2б-2, shownAnswerRef),
 * прочитал держатель ключа новой заявки (`opens_chat`) — отметка `agent_read`
 * в answer_notices. После неё добивка человеку не пишет, а менеджеру, если
 * письмо ему уже ушло, отправляет «звонить не нужно» (lib/requests/answer-notice).
 *
 * Механизм появился раньше слов (#3263): агент, опросивший статус и не
 * сказавший человеку, оставлял его без ответа молча — Ведар считал ответ
 * дошедшим, а агент об этом не знал. «Мы доверяем агенту» держится, только
 * когда агенту сказано, что ему доверено.
 *
 * Один текст на описание инструмента (отсюда — в манифест и навык A2A) и на
 * llms.txt. Сторож связки «слова → отметка»: tests/unit/mcp-request-status.test.ts.
 *
 * Коротко намеренно: мост для моделей с OpenAI-совместимым API режет описание
 * на 1024 знаках (integrations/vedar-mcp-bridge, bridge_description), и первая
 * редакция правила обрывалась там на полуслове. Правило обязано помещаться
 * целиком — это держит tests/unit/vedar-mcp-bridge.test.ts.
 */
export const ANSWER_RELAY_RULE =
  'Ответ туроператора, перевозчика или прокатчика из статуса передайте человеку сами: прочитанный по ключу, выданному при создании заявки, '
  + 'он считается дошедшим, и Ведар человеку о нём больше не сообщает.';

export const GET_REQUEST_STATUS_TOOL = {
  name: REQUEST_STATUS_TOOL_NAME,
  // Описание наружу — всегда «английская фраза + этот текст» (withAnnotations в
  // lib/mcp/public-tools): имена шести пишущих инструментов и «No personal
  // data» называет фраза, здесь они не повторяются. Вместе с фразой и без
  // предложения о notify_url текст обязан помещаться в 1024 знака моста —
  // иначе тот обрежет его на полуслове; пояснения полей (partner_replies и
  // прочие) живут в outputSchema.
  description:
    'Состояние заявки по ключу статуса из ответа пишущего инструмента (у create_trip_request — ключи частей поездки): '
    + 'ждёт оператора, оператор связался, подтверждена, отказ, другая дата, нет ответа. '
    + 'Заявка на жильё — передана (delivered), после ответа владельца кнопкой — в работе (in_progress) или отказ (declined). '
    + 'Ключ выдаётся на каждую заявку и живёт 90 дней; без ключа состояние не узнать. '
    + 'page — страница заявки для человека: там он сам подтверждает согласие на обработку данных и видит ответ. '
    + `${ANSWER_RELAY_RULE} `
    + 'date — действующая дата (у брони — дата брони сейчас), requested_date — дата из заявки: разошлись — бронь перенесена или заведена на другую дату. '
    + 'Если при создании заявки передан notify_url, об изменении состояния, даты, предложенной даты, тура или числа человек приходит подписанный POST; поле notify показывает, жива ли подписка.',
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
      kind: { type: 'string', enum: [...REQUEST_KINDS], description: 'lead — заявка менеджеру или оператору; seat_request — запрос мест у оператора; stay_request — заявка владельцу жилья' },
      tour: { type: ['string', 'null'], description: 'Название тура, если заявка про тур' },
      accommodation: { type: ['string', 'null'], description: 'Название объекта, если заявка на жильё' },
      accommodation_url: { type: ['string', 'null'], description: 'Карточка объекта жилья: там телефон владельца' },
      date: { type: ['string', 'null'], description: 'Дата тура YYYY-MM-DD, если есть, — действующая: у брони та, что в брони сейчас (оператор мог перенести); у заявки на жильё — дата заезда' },
      requested_date: { type: ['string', 'null'], description: 'Дата YYYY-MM-DD, которую просили в заявке, если записана (заявка на тур, запрос мест, жильё). Отличается от date — бронь перенесена или заведена на другую дату' },
      check_out: { type: ['string', 'null'], description: 'Дата выезда YYYY-MM-DD, у заявки на жильё' },
      participants: { type: ['integer', 'null'], description: 'Число человек в заявке (у жилья — гостей), если записано' },
      alt_date: { type: ['string', 'null'], description: 'Дата, которую предложил оператор вместо запрошенной' },
      deadline: { type: ['string', 'null'], description: 'До какого времени ждём ответ оператора (ISO 8601), у запроса мест' },
      human: { type: 'string', description: 'Состояние словами для человека' },
      next: { type: 'string', description: 'Что делать дальше' },
      consent: { type: 'string', enum: ['human', 'agent', 'none'], description: 'Как записано согласие на обработку персональных данных: human — отмечено на странице заявки или в форме сайта (страница открывается ключом заявки, поэтому кто нажал, платформа не проверяет); agent — передал агент при создании; none — не записано' },
      consent_purpose: { type: 'string', enum: [...CONSENT_PURPOSES], description: 'На передачу кому согласие по заявке: operator — туроператору, stay — владельцу жилья, carrier — перевозчику, rental — прокатчику. Этот текст человек подтверждает на странице заявки' },
      page: { type: 'string', description: 'Страница заявки для человека: состояние, ответ оператора и подтверждение согласия своей рукой. Дайте её человеку, не публикуйте.' },
      partner_replies: { type: ['integer', 'null'], description: 'Сколько сообщений адресат заявки (владелец жилья, туроператор, перевозчик, прокат) написал человеку в переписке; текст — только на странице заявки. null — переписки по этому ключу нет' },
      partner_last_reply_at: { type: ['string', 'null'], description: 'Когда адресат написал последнее сообщение (ISO 8601); null — не писал или переписки по ключу нет' },
      max_link: { type: ['string', 'null'], description: 'Ссылка подключить MAX: ответы адресата будут приходить человеку туда. Дайте её человеку, не публикуйте; null — MAX уже подключён или переписки по ключу нет' },
      notify: NOTIFY_STATUS_PROPERTY,
    },
    required: ['state', 'kind', 'human', 'next', 'consent', 'consent_purpose', 'page'],
  },
} as const;
