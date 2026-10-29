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
 * `delivered` — заявка передана, и дальше платформа ответа не видит. Так
 * устроена заявка на жильё (#2371, 14.10): своего жизненного цикла у неё
 * нет, владелец отвечает гостю звонком. «Ждёт ответа» здесь было бы
 * обещанием, которое не сбудется: страница переспрашивала бы вечно.
 */
export const REQUEST_STATES = [
  'awaiting_operator', 'delivered', 'operator_contacted', 'in_progress', 'confirmed',
  'declined', 'other_date', 'no_answer', 'cancelled', 'failed', 'unknown',
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
  description: 'Подписка на уведомления этой заявки: null — не заводилась (notify_url не передан) или удалена через 30 дней после отключения. active: false — уведомлений больше не будет, опрашивайте get_request_status; disabled_reason: gone — приёмник ответил 410; undeliverable — приёмник не принимает; vedar_failure — сбой на стороне Ведара',
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

export const GET_REQUEST_STATUS_TOOL = {
  name: REQUEST_STATUS_TOOL_NAME,
  description:
    'Состояние заявки, отправленной через create_lead, create_booking_request, create_stay_request, request_charter или create_car_rental_request, по ключу статуса из ответа того инструмента: '
    + 'ждёт оператора, оператор связался, подтверждена, отказ, другая дата, нет ответа. '
    + 'Заявка на жильё — кому передана (delivered): владелец отвечает человеку звонком, и его ответа платформа не видит. Без имени и телефона. '
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
      consent: { type: 'string', enum: ['human', 'agent', 'none'], description: 'Чьё согласие на обработку персональных данных записано: human — человек подтвердил сам (страница заявки или форма сайта); agent — передал агент при создании; none — не записано' },
      consent_purpose: { type: 'string', enum: [...CONSENT_PURPOSES], description: 'На передачу кому согласие по заявке: operator — туроператору, stay — владельцу жилья, carrier — перевозчику. Этот текст человек подтверждает на странице заявки' },
      page: { type: 'string', description: 'Страница заявки для человека: состояние, ответ оператора и подтверждение согласия своей рукой. Дайте её человеку, не публикуйте.' },
      notify: NOTIFY_STATUS_PROPERTY,
    },
    required: ['state', 'kind', 'human', 'next', 'consent', 'consent_purpose', 'page'],
  },
} as const;
