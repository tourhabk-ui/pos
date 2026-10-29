/**
 * get_request_status — состояние заявки для агента по ключу (ступень 1
 * агентного контура, #2371; миграция 1220).
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * После заявки через MCP или A2A агент не мог узнать ничего и не мог
 * вернуться к человеку с ответом: номер заявки в ответе не называется
 * намеренно (совпавший номер — оракул «этот телефон уже просил этот тур на
 * эту дату», проверка MCP 29.09), а страница статуса с ключом есть только у
 * запроса мест. Теперь каждый вызов пишущего инструмента выдаёт СВОЙ
 * случайный ключ: он не номер, одинаков по форме у новой и повторной заявки
 * и ничего о ней не говорит; по нему здесь читается состояние.
 *
 * ── Что отдаётся и что нет ─────────────────────────────────────────────────
 *
 * Состояние одним словом из закрытого словаря (REQUEST_STATES), название
 * тура, дата, число человек, предложенная оператором дата, срок ответа и
 * текст для человека. Имени, телефона, комментария, номера лида и ссылки на
 * бронь (в ней ключ доступа человека) нет by construction: SQL их не
 * выбирает. Ключ не найден или истёк — отказ по входу с объяснением, не
 * «заявки нет»; база не ответила — исключение с SQLSTATE в логе (§4.0), а не
 * «ждёт оператора».
 *
 * ── Страница для человека (вторая половина ступени 1) ──────────────────────
 *
 * Тот же ключ открывает человеку страницу `/request-status#<ключ>`: состояние
 * и ответ оператора — и галочка согласия на обработку ПД, та же, что на
 * формах сайта. Согласие, записанное агентом (`consent: true` в вызове), —
 * утверждение агента, не галочка человека (долг в шапке write-guard);
 * подтверждение человека пишется поверх с источником `request-page`
 * (`confirmConsent`). В ответе инструмента это видно полем `consent`:
 * human / agent / none.
 *
 * ── Заявка на жильё (14.10, миграция 1238) ─────────────────────────────────
 *
 * create_stay_request выдаёт ключ тем же путём. Своего жизненного цикла у
 * такой заявки нет: платформа знает, кому она доставлена (1213), а ответ
 * владелец даёт гостю звонком. Поэтому статус — `delivered` с тем, кому
 * передана, а не «ждёт ответа», который никогда не придёт.
 *
 * Согласие человек подтверждает тем текстом, кому уходят его данные
 * (`consent_purpose`): владельцу жилья, перевозчику или туроператору. До
 * 14.10 страница показывала и писала «туроператору» и для заявки на машину —
 * версия перевозчика, записанная агентом, затиралась версией, которая о
 * перевозчике молчит.
 *
 * Сторожа: tests/unit/mcp-request-status.test.ts (форма, словарь, отсутствие
 * ПД, хеш вместо ключа), tests/integration/mcp-request-status.pg.test.ts
 * (SQL на схеме прода).
 */

import { createHash, randomBytes } from 'node:crypto';
import { pool } from '@/lib/db-pool';
import { getPublicBaseUrl } from '@/lib/config';
import type { PdConsentRecord } from '@/lib/legal/pd-consent';
import { McpUserError } from '@/lib/mcp/jsonrpc';
import { logText } from '@/lib/log/log-text';
import { effectiveStatus, type SeatRequestStatus, type FailureKind } from '@/lib/seat-requests/core';
import {
  REQUEST_KEY_MIN_CHARS, REQUEST_KEY_MAX_CHARS, publicDisabledReason,
  type RequestState, type RequestKind, type ConsentPurpose, type RequestNotifyStatus,
} from '@/lib/mcp/request-status-schema';
import { BOOKING_STATUSES, LEAD_STATUSES, type BookingStatus, type LeadStatus } from '@/lib/types/statuses';

export { REQUEST_STATUS_TOOL_NAME, GET_REQUEST_STATUS_TOOL } from '@/lib/mcp/request-status-schema';

/** Сколько живёт ключ. Заявка на тур следующего сезона старше трёх месяцев — редкость. */
export const REQUEST_KEY_TTL_DAYS = 90;

/** Страница заявки для человека: ключ — во фрагменте адреса, как у `/seat-request` (на сервер и в метрику не уходит). */
export const REQUEST_STATUS_PAGE_PATH = '/request-status';

export function requestStatusPageUrl(key: string): string {
  return `${getPublicBaseUrl()}${REQUEST_STATUS_PAGE_PATH}#${key}`;
}

/**
 * Источник согласия, записанный пишущим инструментом: `consent: true` ставит
 * агент (`admitWrite` в роуте MCP — `buildConsentRecord(..., 'mcp')`), и такая
 * запись значит «агент утверждает», а не «человек поставил галочку».
 */
export const AGENT_CONSENT_SOURCE = 'mcp';
/** Источник согласия, которое человек подтвердил сам на странице заявки. */
export const HUMAN_CONSENT_SOURCE = 'request-page';

/** Чьё согласие на обработку ПД стоит у заявки. */
export type ConsentBy = 'human' | 'agent' | 'none';

/** Нет времени согласия — не записано; источник агента — агент; всё прочее (формы сайта, страница заявки) — человек. */
export function consentBy(source: string | null | undefined, at: Date | string | null | undefined): ConsentBy {
  if (!at) return 'none';
  return source === AGENT_CONSENT_SOURCE ? 'agent' : 'human';
}

/** Пишущие инструменты, чьи данные уходят не туроператору (lib/mcp/public-tools). */
const STAY_TOOL_NAME = 'create_stay_request';
const BOOKING_TOOL_NAME = 'create_booking_request';
const CHARTER_TOOL_NAME = 'request_charter';
const CAR_RENTAL_TOOL_NAME = 'create_car_rental_request';

/**
 * На передачу кому согласие по заявке этого инструмента. Данные заявки на
 * жильё получает владелец, заявки на машину — перевозчик (§14): галочка
 * «туроператору» их не покрывает.
 */
export function consentPurposeForTool(toolName: string): ConsentPurpose {
  if (toolName === STAY_TOOL_NAME) return 'stay';
  if (toolName === CHARTER_TOOL_NAME) return 'carrier';
  if (toolName === CAR_RENTAL_TOOL_NAME) return 'rental';
  return 'operator';
}

const KEY_RE = /^[A-Za-z0-9_-]+$/;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export type RequestKeyTarget = { leadId: string } | { seatRequestId: string } | { stayRequestId: string };

/**
 * Выдать ключ на заявку. В базу — только хеш; сырой ключ возвращается ровно
 * один раз. Отказ базы — null и строка в лог: заявка уже принята, и без
 * ключа она не хуже, чем была до 12.10; агент услышит, что ключа нет.
 */
export async function issueRequestKey(target: RequestKeyTarget, toolName: string): Promise<string | null> {
  return (await issueRequestKeyRecord(target, toolName))?.key ?? null;
}

/** Выданный ключ и номер его строки: номер нужен подписке на уведомления (1348). */
export interface IssuedRequestKey {
  key: string;
  /** Номер строки ключа; null — база не вернула строку (не бывает при живой вставке). */
  keyId: string | null;
}

/** То же, что issueRequestKey, но с номером строки ключа — для подписки на уведомления. */
export async function issueRequestKeyRecord(target: RequestKeyTarget, toolName: string): Promise<IssuedRequestKey | null> {
  const key = randomBytes(24).toString('base64url');
  const leadId = 'leadId' in target ? target.leadId : null;
  const seatRequestId = 'seatRequestId' in target ? target.seatRequestId : null;
  const stayRequestId = 'stayRequestId' in target ? target.stayRequestId : null;
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agent_request_keys (key_hash, lead_id, seat_request_id, stay_request_id, tool_name, expires_at)
       VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, NOW() + ($6::int * INTERVAL '1 day'))
       RETURNING id::text AS id`,
      [sha256(key), leadId, seatRequestId, stayRequestId, toolName, REQUEST_KEY_TTL_DAYS],
    );
    const row = rows?.[0];
    return { key, keyId: row?.id ?? null };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[request-status] ключ не выдан:', logText(toolName), typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    return null;
  }
}

/**
 * Хвост ответа пишущего инструмента: ключ есть — как им пользоваться; нет —
 * так и сказано. У заявки на жильё ответа владельца платформа не видит, и
 * хвост этого не обещает.
 */
export function keyLine(key: string | null, kind: 'request' | 'stay' = 'request'): string {
  if (kind === 'stay') {
    return key
      ? ` Ключ статуса заявки: ${key} — по нему get_request_status покажет, кому передана заявка (без имени и телефона).`
        + ' Ответ владелец даёт звонком, и платформа его не видит.'
        + ` Человеку дайте ссылку ${requestStatusPageUrl(key)}: там он сам подтверждает согласие на передачу данных владельцу жилья.`
        + ' Ключ и ссылку не публикуйте.'
      : ' Ключ статуса заявки не выдан (сбой записи ключа): исход знает только владелец, телефон — на карточке объекта.';
  }
  return key
    ? ` Ключ статуса заявки: ${key} — по нему get_request_status покажет, ответил ли оператор (без имени и телефона).`
      + ` Человеку дайте ссылку ${requestStatusPageUrl(key)}: там он сам подтверждает согласие на обработку данных и видит ответ оператора.`
      + ' Ключ и ссылку не публикуйте.'
    : ' Ключ статуса заявки не выдан (сбой записи ключа): узнать исход можно только по звонку оператора.';
}

export interface RequestStatusView {
  state: RequestState;
  kind: RequestKind;
  tour: string | null;
  /** Объект и его карточка — у заявки на жильё; на карточке телефон владельца. */
  accommodation: string | null;
  accommodation_url: string | null;
  /** Дата тура или заезда — действующая: у брони та, что в брони сейчас (оператор мог перенести). */
  date: string | null;
  /** Дата, которую просили в заявке, — если записана (запрос мест, заявка на бронь тура, жильё). */
  requested_date: string | null;
  /** Дата выезда — у заявки на жильё. */
  check_out: string | null;
  participants: number | null;
  alt_date: string | null;
  deadline: string | null;
  human: string;
  next: string;
  /** Чьё согласие на обработку ПД записано: человек сам (страница заявки или форма сайта), агент при создании, никто. */
  consent: ConsentBy;
  /** На передачу кому это согласие: туроператору, владельцу жилья, перевозчику. */
  consent_purpose: ConsentPurpose;
  /** Страница заявки для человека — ключ во фрагменте. */
  page: string;
  /** Подписка на уведомления этой заявки (1348): null — не заводилась или уже удалена. */
  notify: RequestNotifyStatus | null;
}

/**
 * Строка читателя — одна форма на обе обёртки SQL (по ключу и по номерам
 * ключей). Поля, которых нет у старых строк тестов, необязательны: их
 * отсутствие читается как «не записано».
 */
export interface StatusRow {
  /** Номер ключа — его отдаёт обёртка по номерам (для сверки уведомлений). */
  key_id?: string | null;
  tool_name: string;
  lead_id: string | null;
  seat_request_id: string | null;
  lead_status: string | null;
  route_title: string | null;
  /** Дата из заявки на бронь тура (`source_data.date`): текст, проверяется здесь, а не `::date` в SQL. */
  lead_requested_date?: string | null;
  /** Тур заявки на бронь — из каталога по номеру `source_data.tour_id`, который записал роут MCP (не текст человека). */
  lead_tour?: string | null;
  booking_status: string | null;
  booking_date: string | null;
  booking_participants: number | null;
  booking_tour: string | null;
  seat_status: SeatRequestStatus | null;
  deadline_at: Date | string | null;
  answered_at: Date | string | null;
  seat_date: string | null;
  seat_participants: number | null;
  alt_date: string | null;
  failure_kind: FailureKind | null;
  seat_tour: string | null;
  /** Бронь, заведённая по запросу мест (`tour_seat_requests.booking_id`); статус NULL при номере — бронь удалена. */
  seat_booking_id?: string | null;
  seat_booking_status?: string | null;
  seat_booking_date?: string | null;
  seat_booking_participants?: number | null;
  seat_booking_tour?: string | null;
  /** Подписка на уведомления по этому ключу (1348). */
  notify_ref?: string | null;
  notify_disabled_reason?: string | null;
  lead_consent_at: Date | string | null;
  lead_consent_source: string | null;
  seat_consent_at: Date | string | null;
  seat_consent_source: string | null;
  stay_request_id: string | null;
  stay_accommodation_id: string | null;
  stay_name: string | null;
  stay_check_in: string | null;
  stay_check_out: string | null;
  stay_guests: number | null;
  stay_owner_channel: string | null;
  stay_platform_channel: string | null;
  stay_delivery_recorded_at: Date | string | null;
  stay_consent_at: Date | string | null;
  stay_consent_source: string | null;
}

/**
 * Статус брони → состояние для агента. Одна таблица на лид и запрос мест: до
 * 29.10 запрос мест на бронь не смотрел вовсе, а лид знал три слова из
 * шести, и неявка (`no_show`) читалась «ждёт оператора».
 *
 * `Record` по словарю — компилятор не даст добавить статус в
 * `BOOKING_STATUSES` без строки здесь. `no_show` — `declined`: его текст
 * («отказал или она не состоялась») уже покрывает неявку, а фраза «человек не
 * пришёл» — факт о человеке, и чужому адресу уведомления он ни к чему.
 * `pending_payment` — как прежде «ждёт оператора»: оплата через платформу
 * выключена с 05.10.
 */
const BOOKING_STATE: Record<BookingStatus, RequestState> = {
  new: 'awaiting_operator',
  pending_payment: 'awaiting_operator',
  confirmed: 'confirmed',
  completed: 'confirmed',
  cancelled: 'cancelled',
  no_show: 'declined',
};

/**
 * Статус лида → состояние. Весь словарь `LEAD_STATUSES`: до 29.10 здесь было
 * пять слов из девяти, и лид после разбора ИИ-конвейером (`ai_qualified`
 * через полчаса после create_lead) читался «состояние не распознано».
 * Конвейер — не ответ человека (`UNATTENDED_LEAD_STATUSES`): `ai_*` — «ждёт
 * оператора»; предложение отправлено и ждёт подтверждения — «в работе».
 */
const LEAD_STATE: Record<LeadStatus, RequestState> = {
  new: 'awaiting_operator',
  ai_processing: 'awaiting_operator',
  ai_qualified: 'awaiting_operator',
  contacted: 'operator_contacted',
  qualified: 'in_progress',
  proposal_sent: 'in_progress',
  awaiting_confirm: 'in_progress',
  converted: 'confirmed',
  lost: 'declined',
};

function inDictionary<T extends string>(dict: readonly T[], value: string | null | undefined): value is T {
  return typeof value === 'string' && (dict as readonly string[]).includes(value);
}

/** Слово вне словаря — `unknown`: «не распознано» честнее догадки. */
export function bookingState(status: string | null | undefined): RequestState {
  return inDictionary(BOOKING_STATUSES, status) ? BOOKING_STATE[status] : 'unknown';
}

/** Лид: сначала бронь по нему (если оператор уже завёл), иначе статус самого лида. */
export function leadState(leadStatus: string | null, bookingStatus: string | null): RequestState {
  if (bookingStatus) return bookingState(bookingStatus);
  return inDictionary(LEAD_STATUSES, leadStatus) ? LEAD_STATE[leadStatus] : 'unknown';
}

export function seatState(status: SeatRequestStatus): RequestState {
  switch (status) {
    case 'pending': return 'awaiting_operator';
    case 'confirmed': return 'confirmed';
    case 'declined': return 'declined';
    case 'other_date': return 'other_date';
    case 'expired': return 'no_answer';
    case 'failed': return 'failed';
    default: return 'unknown';
  }
}

/** Кому дошла заявка на жильё. Доставка — только MAX: заглушка в Telegram идёт без имени и телефона, перезвонить по ней нельзя. */
export type StayDelivery = 'owner' | 'platform' | 'none' | 'not_recorded';

/** Исход доставки из строки stay_requests (1213). Время записи пусто — «не записано», а не «не дошло». */
export function stayDelivery(
  ownerChannel: string | null,
  platformChannel: string | null,
  recordedAt: Date | string | null,
): StayDelivery {
  if (!recordedAt) return 'not_recorded';
  if (ownerChannel === 'max') return 'owner';
  if (platformChannel === 'max') return 'platform';
  return 'none';
}

export function stayState(delivery: StayDelivery): RequestState {
  switch (delivery) {
    case 'owner':
    case 'platform': return 'delivered';
    case 'none': return 'failed';
    default: return 'unknown';
  }
}

const STAY_HUMAN: Record<StayDelivery, string> = {
  owner: 'Заявка передана владельцу жилья в мессенджер. Владелец отвечает звонком по телефону из заявки, и его ответа платформа не видит.',
  platform: 'Заявка у оператора Ведара: владелец пока не подключил мессенджер, оператор передаст её ему. Владелец отвечает звонком, и его ответа платформа не видит.',
  none: 'Заявка записана, но не дошла ни владельцу, ни оператору Ведара.',
  not_recorded: 'Заявка записана, но куда она дошла, не записано.',
};

const STAY_CALL_SELF = 'телефон на карточке объекта (accommodation_url).';

const STAY_NEXT: Record<StayDelivery, string> = {
  owner: `Владелец позвонит человеку и подтвердит даты и цену. Если звонка долго нет, человеку стоит позвонить самому: ${STAY_CALL_SELF} Спрашивать статус снова незачем: после передачи он не меняется.`,
  platform: `Владелец позвонит человеку и подтвердит даты и цену. Если звонка долго нет, человеку стоит позвонить самому: ${STAY_CALL_SELF} Спрашивать статус снова незачем: после передачи он не меняется.`,
  none: `Человеку стоит позвонить владельцу самому: ${STAY_CALL_SELF}`,
  not_recorded: `Если владелец не позвонил, человеку стоит позвонить ему самому: ${STAY_CALL_SELF}`,
};

const HUMAN: Record<RequestState, string> = {
  awaiting_operator: 'Заявка принята, оператор ещё не ответил.',
  delivered: 'Заявка передана; ответ дают звонком, и платформа его не видит.',
  operator_contacted: 'Оператор связался с человеком по заявке.',
  in_progress: 'Заявка в работе у оператора: детали уточняются.',
  confirmed: 'Оператор подтвердил заявку.',
  declined: 'Оператор отказал по заявке или она не состоялась.',
  other_date: 'На запрошенную дату мест нет, оператор предложил другую дату.',
  no_answer: 'Оператор не ответил в срок.',
  cancelled: 'Бронь по заявке отменена.',
  failed: 'Ответ оператора не записался — исход выясняется у оператора напрямую.',
  unknown: 'Состояние заявки не распознано.',
};

const NEXT: Record<RequestState, string> = {
  awaiting_operator: 'Подождите звонка оператора; повторно спрашивать статус раньше чем через час не нужно.',
  delivered: 'Подождите звонка; спрашивать статус снова незачем: после передачи он не меняется.',
  operator_contacted: 'Дальнейшее человек согласует с оператором по телефону.',
  in_progress: 'Дальнейшее человек согласует с оператором по телефону.',
  confirmed: 'Оплата — оператору напрямую, он скажет как. Через платформу оплаты нет.',
  declined: 'Можно выбрать другой тур или дату: get_tours, get_tour_availability; подбор — create_lead.',
  other_date: 'Если дата подходит, человек подтверждает её оператору по телефону; иначе — другой тур или дата.',
  no_answer: 'Это не значит, что мест нет: можно оставить заявку через create_lead — менеджер свяжется с оператором сам.',
  cancelled: 'Можно оставить новую заявку: create_booking_request или create_lead.',
  failed: 'Человеку стоит связаться с оператором напрямую; можно оставить заявку через create_lead.',
  unknown: 'Человеку стоит связаться с оператором напрямую; можно оставить заявку через create_lead.',
};

function iso(v: Date | string | null): string | null {
  if (!v) return null;
  const t = v instanceof Date ? v : new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function readKey(raw: unknown): string {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key.length < REQUEST_KEY_MIN_CHARS || key.length > REQUEST_KEY_MAX_CHARS || !KEY_RE.test(key)) {
    throw new McpUserError('Ключ статуса не похож на выданный — передайте его как есть из ответа пишущего инструмента.', 'invalid_args:key');
  }
  return key;
}

/**
 * Что читать о заявке — общая часть двух обёрток (по ключу и по номерам
 * ключей). Бронь по лиду — последняя не удалённая (оператор мог завести
 * одну). Запрос мест смотрит на СВОЮ бронь (`r.booking_id`): до 29.10 он её
 * не читал, и после переноса агент видел старую дату, а после отмены —
 * «подтверждена» навсегда.
 */
const REQUEST_STATUS_SELECT = `
  SELECT k.id::text AS key_id, k.tool_name, k.lead_id::text, k.seat_request_id::text, k.stay_request_id::text,
         l.status AS lead_status, l.route_title, l.source_data->>'date' AS lead_requested_date, lt.title AS lead_tour,
         ob.booking_status, ob.booking_date::text AS booking_date, ob.participants AS booking_participants, ot.title AS booking_tour,
         r.status AS seat_status, r.deadline_at, r.answered_at, r.tour_date::text AS seat_date,
         r.participants AS seat_participants, r.alt_date::text AS alt_date, r.failure_kind, st.title AS seat_tour,
         r.booking_id::text AS seat_booking_id, sb.booking_status AS seat_booking_status,
         sb.booking_date::text AS seat_booking_date, sb.participants AS seat_booking_participants, sbt.title AS seat_booking_tour,
         l.pd_consent_at AS lead_consent_at, l.pd_consent_source AS lead_consent_source,
         r.pd_consent_at AS seat_consent_at, r.pd_consent_source AS seat_consent_source,
         s.accommodation_id::text AS stay_accommodation_id, a.name AS stay_name,
         s.check_in_date::text AS stay_check_in, s.check_out_date::text AS stay_check_out, s.guests AS stay_guests,
         s.owner_channel AS stay_owner_channel, s.platform_channel AS stay_platform_channel,
         s.delivery_recorded_at AS stay_delivery_recorded_at,
         s.pd_consent_at AS stay_consent_at, s.pd_consent_source AS stay_consent_source,
         n.ref AS notify_ref, n.disabled_reason AS notify_disabled_reason
    FROM k
    LEFT JOIN leads l ON l.id = k.lead_id
    -- Тур заявки на бронь — по номеру, который записал роут MCP; приведение
    -- только числу: source_data — jsonb, и чужая форма даёт «не записано», а
    -- не 22P02 на весь ответ.
    LEFT JOIN operator_tours lt
           ON lt.id = CASE WHEN l.source_data->>'tour_id' ~ '^[0-9]{1,18}$' THEN (l.source_data->>'tour_id')::bigint END
    LEFT JOIN LATERAL (
      SELECT b.booking_status, b.booking_date, b.participants, b.operator_tour_id
        FROM operator_bookings b
       WHERE b.lead_id = k.lead_id AND b.deleted_at IS NULL
       ORDER BY b.created_at DESC
       LIMIT 1
    ) ob ON k.lead_id IS NOT NULL
    LEFT JOIN operator_tours ot ON ot.id = ob.operator_tour_id
    LEFT JOIN tour_seat_requests r ON r.id = k.seat_request_id
    LEFT JOIN operator_tours st ON st.id = r.tour_id
    LEFT JOIN operator_bookings sb ON sb.id = r.booking_id AND sb.deleted_at IS NULL
    LEFT JOIN operator_tours sbt ON sbt.id = sb.operator_tour_id
    LEFT JOIN stay_requests s ON s.id = k.stay_request_id
    LEFT JOIN accommodations a ON a.id = s.accommodation_id
    LEFT JOIN agent_request_notify n ON n.key_id = k.id`;

/** По ключу: живой ключ → отметка прочтения и строка заявки. Это читает агент. */
export const REQUEST_STATUS_SQL = `
  WITH k AS (
    UPDATE agent_request_keys
       SET last_read_at = NOW(), read_count = read_count + 1
     WHERE key_hash = $1 AND expires_at > NOW()
    RETURNING id, lead_id, seat_request_id, stay_request_id, tool_name
  )${REQUEST_STATUS_SELECT}`;

/**
 * По номерам ключей, без отметки прочтения: так читает сверка уведомлений.
 * Сырого ключа у неё нет и быть не должно, а прочтение — это обращение
 * агента, не наше.
 */
export const REQUEST_STATUS_BY_KEY_IDS_SQL = `
  WITH k AS (
    SELECT id, lead_id, seat_request_id, stay_request_id, tool_name
      FROM agent_request_keys
     WHERE id = ANY($1::uuid[]) AND expires_at > NOW()
  )${REQUEST_STATUS_SELECT}`;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Дата из `source_data` — текст, записанный агентом; не той формы — «не записано». */
function dayOrNull(v: string | null | undefined): string | null {
  return typeof v === 'string' && ISO_DAY.test(v) ? v : null;
}

/**
 * Дата брони не та, что просили в заявке: оператор перенёс бронь или завёл
 * её на другую дату. Агенту это видно и без уведомления — одной строкой.
 */
function dateChangeNote(requested: string | null, actual: string | null): string {
  return requested && actual && requested !== actual
    ? ` Дата отличается от заявки: в заявке ${requested}, в брони ${actual}.`
    : '';
}

/** Вид заявки без страницы человека: его собирают и агенту, и сверке уведомлений. */
export type RequestCore = Omit<RequestStatusView, 'page' | 'notify'>;

/** Поле notify ответа: есть строка подписки — номер, жива ли и почему нет (словом для агента). */
export function notifyStatusOf(row: StatusRow): RequestNotifyStatus | null {
  if (!row.notify_ref) return null;
  const reason = publicDisabledReason(row.notify_disabled_reason);
  return { ref: row.notify_ref, active: row.notify_disabled_reason == null, disabled_reason: reason };
}

const BOOKING_GONE_HUMAN = 'Бронь по заявке не найдена — исход выясняется у оператора напрямую.';

/**
 * Состояние по строке — ОДНА функция на get_request_status и на сверку
 * уведомлений: две сборки разошлись бы, и уведомление сказало бы одно, а
 * опрос — другое. Чистая: строка и время на входе, без базы.
 */
export function buildRequestView(row: StatusRow, now: number): RequestCore {
  const consent_purpose = consentPurposeForTool(row.tool_name);

  if (row.stay_request_id) {
    // Строки заявки нет (удалена между UPDATE и JOIN) — честное unknown.
    const exists = row.stay_accommodation_id !== null;
    const delivery = stayDelivery(row.stay_owner_channel, row.stay_platform_channel, row.stay_delivery_recorded_at);
    const state = exists ? stayState(delivery) : 'unknown';
    return {
      state,
      kind: 'stay_request',
      tour: null,
      accommodation: row.stay_name,
      accommodation_url: exists ? `${getPublicBaseUrl()}/accommodations/${row.stay_accommodation_id}` : null,
      date: row.stay_check_in,
      requested_date: row.stay_check_in,
      check_out: row.stay_check_out,
      participants: row.stay_guests,
      alt_date: null,
      deadline: null,
      human: exists ? STAY_HUMAN[delivery] : HUMAN.unknown,
      next: exists ? STAY_NEXT[delivery] : NEXT.unknown,
      consent: consentBy(row.stay_consent_source, row.stay_consent_at),
      consent_purpose,
    };
  }

  if (row.seat_request_id && row.seat_status) {
    const own = effectiveStatus({ status: row.seat_status, deadline_at: row.deadline_at ?? new Date(0), answered_at: row.answered_at }, now);
    const requested = row.seat_date;
    const consent = consentBy(row.seat_consent_source, row.seat_consent_at);
    // Бронь записана (номер есть) — правда о заявке в ней: перенос, отмена,
    // неявка. Пока бронь `new`, а запрос `failed` (подтверждение не прошло,
    // seat-requests/service), говорит сам запрос; вышла из `new` — бронь.
    if (row.seat_booking_id) {
      const bs = row.seat_booking_status ?? null;
      if (bs === null) {
        // Номер есть, строки нет — бронь удалена. Подтверждённый запрос без
        // брони — не «подтверждена»: исход знает только оператор.
        const state: RequestState = own === 'confirmed' ? 'unknown' : seatState(own);
        return {
          state, kind: 'seat_request', tour: row.seat_tour, accommodation: null, accommodation_url: null,
          date: requested, requested_date: requested, check_out: null, participants: row.seat_participants,
          alt_date: null, deadline: null,
          human: state === 'unknown' ? BOOKING_GONE_HUMAN : HUMAN[state],
          next: NEXT[state], consent, consent_purpose,
        };
      }
      const state: RequestState = bs === 'new' && own === 'failed' ? 'failed' : bookingState(bs);
      const date = row.seat_booking_date ?? requested;
      return {
        state, kind: 'seat_request', tour: row.seat_booking_tour ?? row.seat_tour, accommodation: null, accommodation_url: null,
        date, requested_date: requested, check_out: null,
        participants: row.seat_booking_participants ?? row.seat_participants,
        alt_date: null, deadline: null,
        human: HUMAN[state]
          + (state === 'failed' && row.failure_kind === 'unfinished' ? ' Ответ оператора был получен, но не записан.' : '')
          + dateChangeNote(requested, date),
        next: NEXT[state], consent, consent_purpose,
      };
    }
    const state = seatState(own);
    return {
      state,
      kind: 'seat_request',
      tour: row.seat_tour,
      accommodation: null,
      accommodation_url: null,
      date: requested,
      requested_date: requested,
      check_out: null,
      participants: row.seat_participants,
      alt_date: state === 'other_date' ? row.alt_date : null,
      deadline: state === 'awaiting_operator' ? iso(row.deadline_at) : null,
      human: HUMAN[state] + (state === 'failed' && row.failure_kind === 'unfinished' ? ' Ответ оператора был получен, но не записан.' : ''),
      next: NEXT[state],
      consent,
      consent_purpose,
    };
  }

  // Лид без строки lead: сама заявка удалена (ON DELETE CASCADE снял бы и
  // ключ, но строка могла исчезнуть между UPDATE и JOIN) — честное unknown.
  const state = row.lead_id ? leadState(row.lead_status, row.booking_status) : 'unknown';
  // Запрошенная дата есть только у заявки на бронь тура (её пишет роут MCP в
  // source_data); у подбора, машины и проката даты в этом смысле нет.
  const requested = row.tool_name === BOOKING_TOOL_NAME ? dayOrNull(row.lead_requested_date) : null;
  return {
    state,
    kind: 'lead',
    tour: row.booking_tour ?? leadCatalogTour(row) ?? row.route_title,
    accommodation: null,
    accommodation_url: null,
    date: row.booking_date,
    requested_date: requested,
    check_out: null,
    participants: row.booking_participants,
    alt_date: null,
    deadline: null,
    human: HUMAN[state] + (row.booking_status ? dateChangeNote(requested, row.booking_date) : ''),
    next: NEXT[state],
    consent: consentBy(row.lead_consent_source, row.lead_consent_at),
    consent_purpose,
  };
}

/**
 * Тур заявки на бронь из каталога — по номеру, который записал роут MCP.
 * Одна функция на вид заявки и на снимок уведомления (ревью 29.10): до этого
 * get_request_status называл тур с самого создания, уведомление — только
 * после брони, и первая же бронь на тот же тур приходила с `changed: tour`,
 * будто оператор тур поменял.
 */
function leadCatalogTour(row: StatusRow): string | null {
  return row.tool_name === BOOKING_TOOL_NAME ? row.lead_tour ?? null : null;
}

/**
 * Название тура из каталога (`operator_tours`) — и только оттуда. У лида
 * `tour` вида падает на `leads.route_title`, а у заявки на машину там
 * направление, набранное человеком: свободный текст наружу не уходит.
 */
export function catalogTourOf(row: StatusRow): string | null {
  if (row.stay_request_id) return null;
  if (row.seat_request_id) return row.seat_booking_tour ?? row.seat_tour ?? null;
  return row.booking_tour ?? leadCatalogTour(row);
}

export async function readRequestStatus(rawKey: unknown): Promise<RequestStatusView> {
  const key = readKey(rawKey);
  let row: StatusRow | undefined;
  try {
    ({ rows: [row] } = await pool.query<StatusRow>(REQUEST_STATUS_SQL, [sha256(key)]));
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[request-status] статус не прочитан:', typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    throw new Error('get_request_status: статус не прочитан');
  }
  if (!row) {
    throw new McpUserError(`Ключ не найден или истёк (ключ живёт ${REQUEST_KEY_TTL_DAYS} дней). Проверьте, что передан ключ из ответа инструмента целиком.`, 'key_not_found');
  }
  return { ...buildRequestView(row, Date.now()), page: requestStatusPageUrl(key), notify: notifyStatusOf(row) };
}

export type ConfirmOutcome = 'recorded' | 'already' | 'gone';

/**
 * Один запрос: ключ живой → согласие человека пишется в лид, запрос мест или
 * заявку на жильё ПОВЕРХ записи агента (основание сильнее — его и храним; факт вызова агента
 * остаётся в журнале mcp_tool_calls). Уже подтверждал сам — запись не
 * трогается: первое подтверждение и есть доказательство. Подзапросы к
 * leads/tour_seat_requests в хвосте видят снимок ДО UPDATE той же команды —
 * так и задумано: prior_source — что стояло раньше, target_exists — есть ли
 * сама заявка.
 */
export const CONFIRM_CONSENT_SQL = `
  WITH k AS (
    SELECT lead_id, seat_request_id, stay_request_id
      FROM agent_request_keys
     WHERE key_hash = $1 AND expires_at > NOW()
  ), l AS (
    UPDATE leads
       SET pd_consent_at = $2::timestamptz, pd_consent_ip = $3::varchar, pd_consent_source = $4::varchar, pd_consent_version = $5::varchar
     WHERE id = (SELECT lead_id FROM k) AND pd_consent_source IS DISTINCT FROM $4::varchar
    RETURNING id
  ), r AS (
    UPDATE tour_seat_requests
       SET pd_consent_at = $2::timestamptz, pd_consent_ip = $3::varchar, pd_consent_source = $4::varchar, pd_consent_version = $5::varchar
     WHERE id = (SELECT seat_request_id FROM k) AND pd_consent_source IS DISTINCT FROM $4::varchar
    RETURNING id
  ), s AS (
    UPDATE stay_requests
       SET pd_consent_at = $2::timestamptz, pd_consent_ip = $3::varchar, pd_consent_source = $4::varchar, pd_consent_version = $5::varchar
     WHERE id = (SELECT stay_request_id FROM k) AND pd_consent_source IS DISTINCT FROM $4::varchar
    RETURNING id
  )
  SELECT ((SELECT COUNT(*) FROM l) + (SELECT COUNT(*) FROM r) + (SELECT COUNT(*) FROM s))::int AS updated,
         COALESCE(lp.pd_consent_source, rp.pd_consent_source, sp.pd_consent_source) AS prior_source,
         (lp.id IS NOT NULL OR rp.id IS NOT NULL OR sp.id IS NOT NULL) AS target_exists
    FROM k
    LEFT JOIN leads lp ON lp.id = k.lead_id
    LEFT JOIN tour_seat_requests rp ON rp.id = k.seat_request_id
    LEFT JOIN stay_requests sp ON sp.id = k.stay_request_id`;

interface ConfirmRow { updated: number; prior_source: string | null; target_exists: boolean }

/**
 * Человек подтвердил согласие на странице заявки. Ключ не найден или истёк —
 * отказ по входу (McpUserError), как у чтения; база не ответила — исключение
 * с SQLSTATE в логе, а не «записано».
 */
export async function confirmConsent(rawKey: unknown, record: PdConsentRecord): Promise<ConfirmOutcome> {
  const key = readKey(rawKey);
  let row: ConfirmRow | undefined;
  try {
    ({ rows: [row] } = await pool.query<ConfirmRow>(CONFIRM_CONSENT_SQL, [sha256(key), record.at, record.ip, record.source, record.version]));
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[request-status] согласие не записано:', typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    throw new Error('request-status: согласие не записано');
  }
  if (!row) {
    throw new McpUserError(`Ключ не найден или истёк (ключ живёт ${REQUEST_KEY_TTL_DAYS} дней).`, 'key_not_found');
  }
  if (row.updated > 0) return 'recorded';
  return row.target_exists ? 'already' : 'gone';
}

/** Род заявки по ключу без отметки прочтения: какой текст согласия человек подтверждает. */
export const CONSENT_PURPOSE_SQL = `
  SELECT tool_name
    FROM agent_request_keys
   WHERE key_hash = $1 AND expires_at > NOW()`;

/**
 * На передачу кому согласие по заявке этого ключа — до записи согласия.
 * Страница показывает тот же текст по `consent_purpose` из статуса: оба
 * выводятся из имени инструмента, создавшего заявку. Ключа нет — отказ по
 * входу; база не ответила — исключение с SQLSTATE в логе (§4.0).
 */
export async function readConsentPurpose(rawKey: unknown): Promise<ConsentPurpose> {
  const key = readKey(rawKey);
  let row: { tool_name: string } | undefined;
  try {
    ({ rows: [row] } = await pool.query<{ tool_name: string }>(CONSENT_PURPOSE_SQL, [sha256(key)]));
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[request-status] род заявки не прочитан:', typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    throw new Error('request-status: род заявки не прочитан');
  }
  if (!row) {
    throw new McpUserError(`Ключ не найден или истёк (ключ живёт ${REQUEST_KEY_TTL_DAYS} дней).`, 'key_not_found');
  }
  return consentPurposeForTool(row.tool_name);
}

/** Исполнитель для роута MCP: JSON-строка того же объекта (как у search/fetch). */
export async function runRequestStatusTool(rawArgs: Record<string, unknown>): Promise<string> {
  return JSON.stringify(await readRequestStatus(rawArgs.key));
}
