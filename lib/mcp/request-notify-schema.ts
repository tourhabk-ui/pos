/**
 * Уведомление агенту об изменении заявки (слово владельца 29.10) —
 * объявление без базы: поле notify_url пишущих инструментов, тело
 * уведомления, поле notify в ответе get_request_status, тексты.
 *
 * Без базы и без node:-модулей сети — по той же причине, что
 * request-status-schema: реестр инструментов читает страница /mcp, которая
 * собирается без DATABASE_URL. Исполнение — lib/mcp/request-notify
 * (подписка и сверка) и lib/mcp/notify-send (подпись и отправка).
 */

import { z } from 'zod';
import { checkNotifyUrlShape, NOTIFY_URL_MAX_CHARS } from '@/lib/security/notify-url-shape';
import { REQUEST_KINDS, REQUEST_STATES } from '@/lib/mcp/request-status-schema';

export { NOTIFY_PUBLIC_REASONS, publicDisabledReason, NOTIFY_STATUS_PROPERTY, type NotifyPublicReason, type RequestNotifyStatus } from '@/lib/mcp/request-status-schema';

/**
 * Инструменты, принимающие notify_url. Заявки на жильё здесь нет: после
 * передачи владельцу её состояние не меняется (ответ — звонком, платформа его
 * не видит), и подписка была бы проводом в никуда (правило 10.09).
 */
export const NOTIFY_TOOL_NAMES = [
  'create_lead', 'create_booking_request', 'request_charter', 'create_car_rental_request',
  'create_trip_request',
] as const;

/** Что сверка сравнивает — ровно поля отпечатка; `changed` в теле — подмножество этого списка. */
export const NOTIFY_CHANGED_FIELDS = ['state', 'date', 'alt_date', 'tour', 'participants'] as const;
export type NotifyChangedField = (typeof NOTIFY_CHANGED_FIELDS)[number];

/** Причины отключения в базе (CHECK миграции 1348). */
export const NOTIFY_DISABLED_REASONS = ['gone', 'rejected', 'undeliverable', 'expired', 'undecryptable'] as const;
export type NotifyDisabledReason = (typeof NOTIFY_DISABLED_REASONS)[number];

/**
 * Поле notify_url в inputSchema четырёх инструментов. Слов secret/token/
 * password латиницей здесь нет: описания уходят в OpenAPI и карточку A2A, а
 * их сторожа такие слова запрещают.
 */
export const NOTIFY_URL_PROPERTY = {
  type: 'string',
  description: 'Необязательно. HTTPS-адрес вашего приёмника (только имя хоста, порт 443): когда изменятся состояние заявки, дата, предложенная оператором дата, тур или число человек, на него придёт подписанный POST (Standard Webhooks); ключ подписи — в ответе один раз. Нет своего приёмника — не передавайте и не придумывайте адрес.',
} as const;

/** Пустая строка — «не передан»: агенты шлют "" в необязательные поля. */
export const notifyUrlField = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string({ error: 'notify_url: адрес приёмника — строкой' })
    .trim()
    .max(NOTIFY_URL_MAX_CHARS, `notify_url: адрес длиннее ${NOTIFY_URL_MAX_CHARS} знаков.`)
    .superRefine((v, ctx) => {
      const shape = checkNotifyUrlShape(v);
      if (!shape.ok) ctx.addIssue({ code: 'custom', message: `${shape.message} Заявка не создана — исправьте адрес или уберите notify_url.` });
    })
    .optional(),
);

/** Фраза в описании четырёх инструментов. */
export const NOTIFY_TOOL_PHRASE = ' Необязательный notify_url — адрес вашего приёмника: при изменении заявки на него придёт подписанный POST (Standard Webhooks).';

/** Как приёмнику проверить подпись и защититься от повтора — один текст на ответ инструмента, OpenAPI и /mcp. */
export const NOTIFY_HOW_TO_VERIFY =
  'Подпись — Standard Webhooks: заголовки webhook-id, webhook-timestamp, webhook-signature «v1,<base64 HMAC-SHA256 от "id.timestamp.тело">», ключ — base64 после whsec_. '
  + 'Отвергайте webhook-timestamp старше 5 минут, повторы отсекайте по webhook-id, а при расхождении верьте снимку с более поздним observed_at.';

/**
 * 4xx, после которых повтор имеет смысл: 408 (таймаут запроса), 425 (рано),
 * 429 (слишком часто). Любой другой 4xx — «адрес не приёмник»: подписка
 * отключается с первого ответа, чтобы чужой адрес получал не больше одного
 * запроса. Исполняет outcomeOfStatus (lib/mcp/notify-send) — по этому же
 * списку, а тексты ниже собраны из него: до ревью 29.10 тексты обещали
 * повтор на любой ответ, кроме 410, а отправитель отключал на первом 404.
 */
export const NOTIFY_RETRY_4XX = [408, 425, 429] as const;

/** После скольких неудач подряд подписка отключается (~31 ч по графику повторов). */
export const NOTIFY_MAX_FAILURES = 7;

function listRu(xs: readonly number[]): string {
  return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} и ${xs[xs.length - 1]}`;
}

/**
 * Что значит ответ приёмника — одно правило на ответ инструмента, OpenAPI,
 * /mcp и llms.txt. Сторож сверяет его с поведением outcomeOfStatus на всех
 * кодах (tests/unit/request-notify.test.ts).
 */
export const NOTIFY_RESPONSE_RULES =
  `Ответ приёмника: 2xx — доставлено. 410 и любой другой 4xx, кроме ${listRu(NOTIFY_RETRY_4XX)}, отключают подписку с первого ответа, без повторов — `
  + 'проверка подписи на приёмнике должна работать к первому уведомлению. '
  + `3xx (редиректам не следуем), ${listRu(NOTIFY_RETRY_4XX)}, 5xx, таймаут и сетевой отказ — повтор с растущим интервалом; `
  + `после ${NOTIFY_MAX_FAILURES} неудач подряд подписка отключается.`;

export const NOTIFY_RESPONSE_RULES_EN =
  `Receiver replies: 2xx means delivered. 410 or any other 4xx except ${NOTIFY_RETRY_4XX.join('/')} disables the subscription on the first reply, with no retries, `
  + 'so signature checking must work by the first notification. '
  + `3xx (redirects are not followed), ${NOTIFY_RETRY_4XX.join('/')}, 5xx, timeouts and network errors are retried with growing intervals; `
  + `after ${NOTIFY_MAX_FAILURES} consecutive failures the subscription is disabled.`;

/** Тело уведомления — одна схема на OpenAPI (webhooks) и сторожа. Имени, телефона, комментария и ключа статуса в нём нет. */
export const REQUEST_NOTIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['request.updated'] },
    ref: { type: 'string', description: 'Номер подписки из ответа пишущего инструмента (nr_…): по нему сопоставляйте уведомление с заявкой' },
    kind: { type: 'string', enum: [...REQUEST_KINDS] },
    tool: { type: 'string', enum: [...NOTIFY_TOOL_NAMES], description: 'Каким инструментом создана заявка' },
    state: { type: 'string', enum: [...REQUEST_STATES], description: 'Состояние сейчас — тот же словарь, что у get_request_status' },
    previous_state: { type: ['string', 'null'], enum: [...REQUEST_STATES, null], description: 'Состояние в прошлом доставленном уведомлении (или при создании подписки); null — неизвестно (reason)' },
    changed: { type: 'array', items: { type: 'string', enum: [...NOTIFY_CHANGED_FIELDS] }, description: 'Что изменилось с прошлого доставленного уведомления' },
    human: { type: 'string', description: 'Состояние словами — тот же текст, что у get_request_status' },
    next: { type: 'string', description: 'Что делать дальше' },
    date: { type: ['string', 'null'], description: 'Действующая дата YYYY-MM-DD (у брони — дата брони сейчас)' },
    previous_date: { type: ['string', 'null'], description: 'Дата в прошлом доставленном уведомлении' },
    requested_date: { type: ['string', 'null'], description: 'Дата, которую просили в заявке, если записана' },
    alt_date: { type: ['string', 'null'], description: 'Дата, которую предложил оператор вместо запрошенной' },
    tour: { type: ['string', 'null'], description: 'Название тура из каталога платформы, если есть' },
    participants: { type: ['integer', 'null'], description: 'Число человек, если записано' },
    observed_at: { type: 'string', description: 'Когда сверка увидела изменение (ISO 8601), а не когда оно случилось: сверка идёт по расписанию' },
    reason: { type: ['string', 'null'], enum: ['baseline_unknown', null], description: 'baseline_unknown — состояние при создании подписки не записалось, previous_* неизвестны' },
    hint: { type: 'string', description: 'Подробности — get_request_status с ключом статуса' },
  },
  required: ['type', 'ref', 'kind', 'tool', 'state', 'previous_state', 'changed', 'human', 'next', 'date', 'previous_date', 'requested_date', 'alt_date', 'tour', 'participants', 'observed_at', 'reason', 'hint'],
  additionalProperties: false,
} as const;
