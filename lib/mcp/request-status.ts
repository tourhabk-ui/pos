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
 * create_stay_request выдаёт ключ тем же путём. Платформа знает, кому
 * заявка доставлена (1213), а ответ владелец даёт гостю звонком. Поэтому
 * статус до ответа кнопкой — `delivered` с тем, кому передана, а не «ждёт
 * ответа», который может не прийти. С 1349 владелец
 * отвечает и в переписке на странице заявки, с 1350 — любой адресат заявки:
 * агенту видно число ответов (`partner_replies`), текста нет. С 1359
 * владелец отвечает и кнопкой — статус её читает (ниже).
 *
 * ── Ответ адресата кнопкой (11.11, план «после отказа», этап 1) ────────────
 *
 * Оператор нажал «Нет мест» — а страница, агент и «Моя поездка» продолжали
 * говорить «ждём ответа»: статус читал только `leads.status`, а «Нет мест»
 * его не меняет. «Беру» перевозчика и «Другая дата» оператора ставят
 * `contacted` — и человек читал «оператор связался с вами», хотя с ним никто
 * не говорил. Теперь ответ кнопкой (тур — `partner_incoming_answers`, машина
 * и прокат — `lead_activity_log.partner_answered`, жильё —
 * `stay_requests.owner_answer`) назван словами, пока статус лида его не
 * перерос. Состояния — из прежнего словаря: внешним агентам новых слов нет.
 * Адресат назван своим словом (оператор, перевозчик, прокатчик), и заявка на
 * машину не зовёт в каталог туров.
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
import { maxBot } from '@/lib/partners/channel-link';
import { notifyLeadHumanConfirmedQuietly } from '@/lib/notifications/lead-human-confirmed';
import { guestBotLink } from '@/lib/requests/request-chat';
import { logText } from '@/lib/log/log-text';
import { isTestKey, testKeyStatus } from '@/lib/mcp/test-run';
import { effectiveStatus, type SeatRequestStatus, type FailureKind } from '@/lib/seat-requests/core';
import {
  REQUEST_KEY_MIN_CHARS, REQUEST_KEY_MAX_CHARS, REQUEST_STATES, ADDRESSEE_WORDS, capitalized, publicDisabledReason,
  type RequestState, type RequestKind, type ConsentPurpose, type RequestNotifyStatus,
} from '@/lib/mcp/request-status-schema';
import { DECLINE_REASON_LABEL, DECLINE_REASONS, type DeclineReason } from '@/lib/requests/chat-answer-buttons';
import { LEAD_ANSWER_DATE_SQL, ruAnswerDate } from '@/lib/requests/answer-date';
import { SELLER_CLOSED_ACTION, isClientLostReason, isLostReason } from '@/lib/leads/lost-reason';
import {
  BOOKING_STATUSES, LEAD_CLIENT_CANCELLED, LEAD_STATUSES, UNATTENDED_LEAD_STATUSES, type BookingStatus, type LeadStatus,
} from '@/lib/types/statuses';

export { REQUEST_STATUS_TOOL_NAME, GET_REQUEST_STATUS_TOOL } from '@/lib/mcp/request-status-schema';

/** Сколько живёт ключ. Заявка на тур следующего сезона старше трёх месяцев — редкость. */
export const REQUEST_KEY_TTL_DAYS = 90;

/** Страница заявки для человека: ключ — во фрагменте адреса, как у `/seat-request` (на сервер и в метрику не уходит). */
export const REQUEST_STATUS_PAGE_PATH = '/request-status';

export function requestStatusPageUrl(key: string): string {
  return `${getPublicBaseUrl()}${REQUEST_STATUS_PAGE_PATH}#${key}`;
}

/**
 * Ссылки человеку после отправки формы (1349, 1350): страница заявки и
 * подключение MAX. Ключ не выдался — обе null, и форма говорит это словами.
 * Форма одинакова у новой заявки и у повтора: у повтора ключ только статусный
 * (`opens_chat` false), и ответ двери не выдаёт, что заявка уже была.
 */
export function requestPageLinks(key: string | null): { page: string | null; max_link: string | null } {
  return key ? { page: requestStatusPageUrl(key), max_link: guestBotLink(maxBot(), key) } : { page: null, max_link: null };
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
/**
 * Ключ заявки на жильё, оставленной формой на карточке объекта (1349): с ним
 * гость открывает страницу заявки с перепиской и подключает MAX. Это не
 * инструмент MCP — имя двери в той же колонке `tool_name`.
 */
export const STAY_FORM_KEY_NAME = 'stay-request-form';
/**
 * Ключи заявок с форм сайта, адресованных партнёру (1350): машина у
 * перевозчика, прокат, заявка туроператору или гиду со страницы компании,
 * её сайта или виджета. С ключом человек открывает страницу заявки с
 * перепиской и подключает MAX.
 */
export const CHARTER_FORM_KEY_NAME = 'charter-request-form';
export const RENTAL_FORM_KEY_NAME = 'car-rental-request-form';
export const LEAD_FORM_KEY_NAME = 'partner-lead-form';
const BOOKING_TOOL_NAME = 'create_booking_request';
const CHARTER_TOOL_NAME = 'request_charter';
const CAR_RENTAL_TOOL_NAME = 'create_car_rental_request';

/**
 * На передачу кому согласие по заявке этого инструмента. Данные заявки на
 * жильё получает владелец, заявки на машину — перевозчик (§14): галочка
 * «туроператору» их не покрывает.
 */
export function consentPurposeForTool(toolName: string): ConsentPurpose {
  if (toolName === STAY_TOOL_NAME || toolName === STAY_FORM_KEY_NAME) return 'stay';
  if (toolName === CHARTER_TOOL_NAME || toolName === CHARTER_FORM_KEY_NAME) return 'carrier';
  if (toolName === CAR_RENTAL_TOOL_NAME || toolName === RENTAL_FORM_KEY_NAME) return 'rental';
  return 'operator';
}

/**
 * Род согласия по ключу. Ключ из кода между каналами (`handoff:<канал>`,
 * lib/requests/handoff) имени инструмента не несёт, и до 11.11 у заявки на
 * машину, прокат и жильё такой ключ читался «туроператору»: статус говорил
 * «оператор», а страница давала подтвердить согласие не тому получателю
 * (ревью этапа 1 плана «после отказа»). Род тогда берётся из самой заявки:
 * жильё — по цели ключа, машина и прокат — по `source_data.kind` лида.
 */
export function consentPurposeOfKey(k: { tool_name: string; stay_request_id?: string | null; lead_kind?: string | null }): ConsentPurpose {
  if (!k.tool_name.startsWith('handoff:')) return consentPurposeForTool(k.tool_name);
  if (k.stay_request_id) return 'stay';
  if (k.lead_kind === 'charter') return 'carrier';
  if (k.lead_kind === 'car_rental') return 'rental';
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
 *
 * `opensChat` (1350) — ключ откроет переписку с адресатом заявки. Ставит его
 * только дверь, которая в этом же вызове СОЗДАЛА заявку: повтор лида
 * возвращает прежний лид, и его ключ получил бы любой, кто знает чужой
 * телефон, — такому ключу только статус.
 */
export async function issueRequestKey(target: RequestKeyTarget, toolName: string, opts: IssueKeyOptions = {}): Promise<string | null> {
  return (await issueRequestKeyRecord(target, toolName, opts))?.key ?? null;
}

/** Что ключ открывает, кроме статуса (1350). */
export interface IssueKeyOptions {
  /** Переписку с адресатом заявки — только у ключа НОВОЙ заявки. */
  opensChat?: boolean;
}

/** Выданный ключ и номер его строки: номер нужен подписке на уведомления (1348). */
export interface IssuedRequestKey {
  key: string;
  /** Номер строки ключа; null — база не вернула строку (не бывает при живой вставке). */
  keyId: string | null;
}

/** То же, что issueRequestKey, но с номером строки ключа — для подписки на уведомления. */
export async function issueRequestKeyRecord(target: RequestKeyTarget, toolName: string, opts: IssueKeyOptions = {}): Promise<IssuedRequestKey | null> {
  const key = randomBytes(24).toString('base64url');
  const leadId = 'leadId' in target ? target.leadId : null;
  const seatRequestId = 'seatRequestId' in target ? target.seatRequestId : null;
  const stayRequestId = 'stayRequestId' in target ? target.stayRequestId : null;
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agent_request_keys (key_hash, lead_id, seat_request_id, stay_request_id, tool_name, expires_at, opens_chat)
       VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, NOW() + ($6::int * INTERVAL '1 day'), $7)
       RETURNING id::text AS id`,
      [sha256(key), leadId, seatRequestId, stayRequestId, toolName, REQUEST_KEY_TTL_DAYS, opts.opensChat === true],
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
 * так и сказано. Переписку (1349, 1350) хвост обещает, когда заявка
 * адресована партнёру, который может ответить (`chat`), — и у новой заявки,
 * и у повтора: ответ на повтор не отличается от ответа на новую (анти-оракул
 * 29.09). Что ключ повтора только статусный, видно лишь по самой ссылке.
 */
export function keyLine(key: string | null, kind: 'request' | 'stay' = 'request', chat = false): string {
  if (kind === 'stay') {
    return key
      ? ` Ключ статуса заявки: ${key} — по нему get_request_status покажет, кому передана заявка и сколько владелец ответил (без имени и телефона).`
        + ' Ответ владелец даёт звонком или сообщением на странице заявки; текст переписки get_request_status не отдаёт.'
        + ` Человеку дайте ссылку ${requestStatusPageUrl(key)}: там он сам подтверждает согласие на передачу данных владельцу жилья и переписывается с владельцем.`
        + ` Чтобы ответы владельца приходили человеку в MAX, дайте ему и эту ссылку: ${guestBotLink(maxBot(), key)}.`
        + ' Ключ и ссылку не публикуйте; ссылку на MAX — тоже.'
      : ' Ключ статуса заявки не выдан (сбой записи ключа): исход знает только владелец, телефон — на карточке объекта.';
  }
  if (!key) return ' Ключ статуса заявки не выдан (сбой записи ключа): узнать исход можно только по звонку оператора.';
  return chat
    ? ` Ключ статуса заявки: ${key} — по нему get_request_status покажет состояние и сколько адресат ответил в переписке (без имени и телефона); текст переписки get_request_status не отдаёт.`
      + ` Человеку дайте ссылку ${requestStatusPageUrl(key)}: там он сам подтверждает согласие на обработку данных и переписывается с адресатом заявки.`
      + ` Чтобы ответы приходили человеку в MAX, дайте ему и эту ссылку: ${guestBotLink(maxBot(), key)}.`
      + ' Ключ и ссылку не публикуйте; ссылку на MAX — тоже.'
    : ` Ключ статуса заявки: ${key} — по нему get_request_status покажет, ответил ли оператор (без имени и телефона).`
      + ` Человеку дайте ссылку ${requestStatusPageUrl(key)}: там он сам подтверждает согласие на обработку данных и видит ответ оператора.`
      + ' Ключ и ссылку не публикуйте.';
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
  /**
   * Переписка (1349, 1350): сколько сообщений написал адресат заявки —
   * владелец жилья, туроператор, перевозчик, прокат — и когда последнее.
   * null — переписки по этому ключу нет (ключ повтора, запрос мест, лид без
   * адресата). Текста нет.
   */
  partner_replies: number | null;
  partner_last_reply_at: string | null;
  /** Ссылка подключить MAX клиента; null — подключён или переписки по ключу нет. */
  max_link: string | null;
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
  /** Число людей, записанное в заявку при создании (`source_data.participants`) — пока оператор не завёл бронь. */
  lead_participants?: number | null;
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
  /**
   * Переписка (1349, 1350): открывает ли её ключ, адресован ли лид партнёру,
   * сколько написал адресат и когда последнее, подключён ли MAX клиента.
   */
  opens_chat?: boolean | null;
  lead_addressed?: boolean | null;
  chat_partner_replies?: number | null;
  chat_partner_last_at?: Date | string | null;
  chat_guest_on_max?: boolean | null;
  /**
   * Ответ адресата кнопкой (11.11, план «после отказа», этап 1). До этого
   * дня статус их не читал: после «Нет мест» страница и агент слышали «ждём
   * ответа», а после «Беру» перевозчика — «оператор связался».
   *   - тур: `partner_incoming_answers` (1334, 1367) — того, кто сейчас
   *     адресат лида: ответ прежнего адресата после передачи не в счёт;
   *   - машина и прокат: последняя запись `lead_activity_log.partner_answered`;
   *   - жильё: `stay_requests.owner_answer` (1359).
   */
  lead_answer?: string | null;
  lead_decline_reason?: string | null;
  lead_partner_answer?: string | null;
  /** Номер записи журнала (lead_activity_log.id) с ответом перевозчика или прокатчика. */
  lead_partner_answer_id?: string | null;
  /** Крон добивки отдал лид менеджеру (`source_data.escalated_to_admin`) — и поставил ему `contacted`. */
  lead_escalated?: boolean | null;
  /** Заявка на группу больше мест тура (`source_data.group_over_seats`) и кто от неё отказался (`declined_by`). */
  /** Номер ответа кнопкой (partner_incoming_answers.id), который читает статус. */
  lead_answer_id?: string | null;
  lead_group_over?: boolean | null;
  lead_declined_by?: string | null;
  /** Род лида (`source_data.kind`): `charter`, `car_rental` — у ключа из кода между каналами имени инструмента нет. */
  lead_kind?: string | null;
  stay_owner_answer?: string | null;
  /**
   * Причина, с которой продавец закрыл заявку «Отказ» в кабинете (12.11, этап
   * 3а; `leads.lost_reason`, 1429). Есть только у текущего закрытия: при любой
   * смене статуса её стирает триггер. `lead_closed_id` — запись журнала
   * (`lead_activity_log.seller_closed`) этого закрытия: на неё ссылается
   * сообщение человеку.
   */
  lead_lost_reason?: string | null;
  lead_closed_id?: string | null;
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
  // Отменил клиент (1427). Слова — CLIENT_CANCELLED_HUMAN: «бронь отменена» здесь было бы неправдой.
  cancelled: 'cancelled',
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
  owner: 'Заявка передана владельцу жилья в мессенджер. Владелец отвечает звонком по телефону из заявки или сообщением на странице заявки; текст переписки здесь не показывается.',
  platform: 'Заявка у оператора Ведара: владелец пока не подключил мессенджер, оператор передаст её ему. Владелец отвечает звонком или сообщением на странице заявки; текст переписки здесь не показывается.',
  none: 'Заявка записана, но не дошла ни владельцу, ни оператору Ведара.',
  not_recorded: 'Заявка записана, но куда она дошла, не записано.',
};

const STAY_CALL_SELF = 'телефон на карточке объекта (accommodation_url).';

/**
 * С 1359 владелец отвечает и кнопкой («Свободно, беру», «Занято», «Позвоню
 * сам») — ответ появляется здесь. До 11.11 эта строка говорила «после
 * передачи статус не меняется», и агент мог не спросить снова.
 */
const STAY_ANSWER_LATER = 'Если владелец ответит кнопкой, ответ появится здесь; спрашивать статус чаще раза в час незачем.';

const STAY_NEXT: Record<StayDelivery, string> = {
  owner: `Владелец позвонит человеку и подтвердит даты и цену. Если звонка долго нет, человеку стоит позвонить самому: ${STAY_CALL_SELF} ${STAY_ANSWER_LATER}`,
  platform: `Владелец позвонит человеку и подтвердит даты и цену. Если звонка долго нет, человеку стоит позвонить самому: ${STAY_CALL_SELF} ${STAY_ANSWER_LATER}`,
  none: `Человеку стоит позвонить владельцу самому: ${STAY_CALL_SELF}`,
  not_recorded: `Если владелец не позвонил, человеку стоит позвонить ему самому: ${STAY_CALL_SELF}`,
};

/**
 * Состояние словами — с тем адресатом, кому ушла заявка: оператор,
 * перевозчик, прокатчик. `switch` без `default`: новое состояние в
 * REQUEST_STATES без строки здесь не соберётся.
 */
function humanText(state: RequestState, purpose: ConsentPurpose): string {
  const w = ADDRESSEE_WORDS[purpose];
  const who = capitalized(w.nom);
  switch (state) {
    case 'awaiting_operator': return `Заявка принята, ${w.nom} ещё не ответил.`;
    case 'delivered': return 'Заявка передана; ответ дают звонком, и платформа его не видит.';
    case 'operator_contacted': return `${who} связался с человеком по заявке.`;
    case 'in_progress': return `Заявка в работе у ${w.gen}: детали уточняются.`;
    case 'confirmed': return `${who} подтвердил заявку.`;
    case 'declined': return `${who} отказал по заявке или она не состоялась.`;
    case 'other_date': return `На запрошенную дату мест нет, ${w.nom} предложил другую дату.`;
    case 'no_answer': return `${who} не ответил в срок.`;
    case 'cancelled': return 'Бронь по заявке отменена.';
    case 'failed': return `Ответ ${w.gen} не записался — исход выясняется у ${w.gen} напрямую.`;
    case 'unknown': return 'Состояние заявки не распознано.';
    case 'test': return 'Пробная заявка: проверки пройдены, но она не записана и никому не передана.';
  }
}

/** Куда идти дальше у заявки на машину и прокат: не в каталог туров. */
const OTHER_OFFERS: Record<'carrier' | 'rental', string> = {
  carrier: 'другие перевозчики по направлению — search_transfers, новая заявка — request_charter',
  rental: 'другие предложения проката — search_car_rental, новая заявка — create_car_rental_request',
};

function nextText(state: RequestState, purpose: ConsentPurpose): string {
  if (purpose === 'carrier' || purpose === 'rental') {
    const w = ADDRESSEE_WORDS[purpose];
    const alt = OTHER_OFFERS[purpose];
    switch (state) {
      case 'awaiting_operator': return `Подождите звонка ${w.gen}; повторно спрашивать статус раньше чем через час не нужно.`;
      case 'operator_contacted':
      case 'in_progress': return `Дальнейшее человек согласует с ${w.ins} по телефону.`;
      case 'confirmed': return `Оплата — ${w.dat} напрямую. Через платформу оплаты нет.`;
      case 'test': return NEXT.test;
      case 'delivered': return NEXT.delivered;
      default: return `Можно: ${alt}.`;
    }
  }
  return NEXT[state];
}

const HUMAN = Object.fromEntries(REQUEST_STATES.map((s) => [s, humanText(s, 'operator')])) as Record<RequestState, string>;

/**
 * Заявку отменил сам клиент, пока адресат не ответил (1427). Состояние то же —
 * `cancelled`, слова свои: у такой заявки брони не было.
 */
export const CLIENT_CANCELLED_HUMAN = 'Заявка отменена клиентом.';

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
  test: 'Ничего делать не нужно. Чтобы заявка ушла адресату, повторите вызов без test: true.',
};

interface AnswerView { state: RequestState; human: string; next: string }

/**
 * Ответ адресата значит что-то, только пока статус лида его не перерос:
 * лид ждёт (никто из людей не брал) или стоит ровно в том статусе, который
 * поставил сам ответ. Дальше говорит статус: оператор мог позже связаться,
 * отправить предложение, закрыть заявку на сайте.
 */
function answerHolds(status: string | null, setsStatus: LeadStatus | null): boolean {
  if (status === null) return false;
  if ((UNATTENDED_LEAD_STATUSES as readonly string[]).includes(status)) return true;
  return setsStatus !== null && status === setsStatus;
}

function isDeclineReason(v: string | null | undefined): v is DeclineReason {
  return typeof v === 'string' && (DECLINE_REASONS as readonly string[]).includes(v);
}

const TOUR_OTHER_DATES = 'Другие даты этого тура — get_tour_availability; другой тур — get_tours.';

/**
 * Отказ по погоде или безопасности (слово владельца 11.11, план, вопрос 3):
 * другие варианты можно, но только безопасные на ЭТУ дату, и с объяснением
 * человеку, почему замена. Обстановка и предупреждения места знают «сейчас»,
 * а не дату поездки — на дату есть только прогноз, и он кончается через
 * несколько дней. Дальше прогноза безопасность не проверить, и это сказано.
 */
const WEATHER_DECLINE_NEXT = 'Отказ из-за погоды или безопасности. Другие варианты на эту дату предлагайте, только если проверили их безопасность: '
  + 'обстановка — safety_status, место — get_guardian_context, прогноз на эту дату — get_weather. '
  + 'Дата дальше прогноза — проверить нельзя, так и скажите человеку. Объясните человеку, почему замена. '
  + 'Другие даты этого тура — get_tour_availability.';

/**
 * Заявка на большую группу (`source_data.group_over_seats`, lib/mcp/
 * booking-capacity): после «Нет мест» или отказа адресата крон добивки отдаёт
 * её другим операторам того же вида туров (lib/leads/followup-scope,
 * GROUP_DECLINED_LEAD_SQL; слово владельца 08.11) — и агенту при создании это
 * обещано. «Ищите другой тур» здесь толкнуло бы агента завести вторую заявку
 * на ту же группу.
 */
const GROUP_PASSED_ON = {
  state: 'awaiting_operator' as RequestState,
  next: 'Новую заявку на эту группу заводить не нужно. Подождите звонка оператора; повторно спрашивать статус раньше чем через час не нужно.',
};

/**
 * Ответ туроператора кнопкой (lib/requests/chat-answer-buttons) → состояние
 * и слова. Ни один из ответов не бронь: «Подтвердить» — оператор берёт
 * заявку, дату и цену он согласует сам.
 */
function tourAnswerView(answer: string, reason: string | null, status: string | null, requested: string | null): AnswerView | null {
  const on = requested ? ` на ${ruAnswerDate(requested)}` : ' на запрошенную дату';
  switch (answer) {
    case 'accept':
      if (!answerHolds(status, 'contacted')) return null;
      return {
        state: 'in_progress',
        human: 'Оператор ответил: берёт заявку. Брони ещё нет: дату и цену он согласует с человеком сам.',
        next: 'Дальнейшее человек согласует с оператором по телефону.',
      };
    case 'other_date':
      if (!answerHolds(status, 'contacted')) return null;
      return {
        state: 'other_date',
        human: `Оператор ответил:${on} не может и предложит другую дату — напишет или позвонит человеку.`,
        next: `Дату подтверждает оператор. ${TOUR_OTHER_DATES}`,
      };
    case 'no_seats':
      if (!answerHolds(status, null)) return null;
      return { state: 'declined', human: `Оператор ответил:${on} мест нет.`, next: TOUR_OTHER_DATES };
    case 'decline': {
      if (!answerHolds(status, 'lost')) return null;
      const label = isDeclineReason(reason) ? DECLINE_REASON_LABEL[reason].toLowerCase() : null;
      return {
        state: 'declined',
        human: label ? `Оператор отказал по заявке. Причина: ${label}.` : 'Оператор отказал по заявке.',
        // Слово владельца 11.11 (план, вопрос 3): после отказа по погоде или
        // безопасности можно предложить другие безопасные варианты — с
        // объяснением, почему замена. Безопасность варианта проверяется, а не
        // предполагается: обстановка и предупреждения по месту.
        next: reason === 'weather'
          ? WEATHER_DECLINE_NEXT
          : TOUR_OTHER_DATES,
      };
    }
    case 'clarify':
      if (!answerHolds(status, null)) return null;
      return {
        state: 'in_progress',
        human: 'Оператор ответил: уточнит детали и свяжется с человеком.',
        next: 'Подождите звонка оператора по телефону из заявки.',
      };
    case 'self':
      if (!answerHolds(status, null)) return null;
      return {
        state: 'in_progress',
        human: 'Оператор ответил: свяжется с человеком сам.',
        next: 'Подождите звонка оператора по телефону из заявки.',
      };
    default:
      return null;
  }
}

/**
 * Продавец закрыл заявку «Отказ» в кабинете и назвал причину (этап 3а,
 * lib/leads/lost-reason). Держится, только пока заявка закрыта. Отказ продавца
 * — теми же словами, что кнопка «Отказать» в чате: человеку незачем знать,
 * какой дверью оператор отказал. Причина на стороне клиента — «по словам
 * оператора»: Ведар её не проверял, и выдавать её за факт нельзя.
 */
function sellerClosedView(reason: string | null | undefined, status: string | null): AnswerView | null {
  if (status !== 'lost' || !isLostReason(reason)) return null;
  if (isClientLostReason(reason)) {
    return reason === 'no_contact'
      ? {
        state: 'declined',
        human: 'Оператор закрыл заявку: по его словам, связаться с человеком по телефону из заявки не удалось.',
        next: 'Если поездка ещё нужна, человек может позвонить оператору сам или оставить новую заявку: create_booking_request.',
      }
      : {
        state: 'declined',
        human: 'Оператор закрыл заявку: по его словам, человек отказался от поездки.',
        next: 'Если это не так, человеку стоит позвонить оператору; новая заявка — create_booking_request.',
      };
  }
  return tourAnswerView('decline', reason, status, null);
}

/** Вид заявки построен из закрытия продавцом с причиной — оно новее любого ответа кнопкой. */
function shownSellerClosed(row: StatusRow): AnswerView | null {
  if (row.booking_status || consentPurposeOfKey(row) !== 'operator') return null;
  return sellerClosedView(row.lead_lost_reason, row.lead_status ?? null);
}

/**
 * Ответ перевозчика или прокатчика («Беру» / «Не могу», lib/rental/
 * request-answer-flow): «Беру» — готов выполнить и свяжется сам, машина этим
 * не закреплена и сумма не названа (§14).
 */
function vehicleAnswerView(answer: string, purpose: 'carrier' | 'rental', status: string | null): AnswerView | null {
  const w = ADDRESSEE_WORDS[purpose];
  const who = capitalized(w.nom);
  if (answer === 'take') {
    if (!answerHolds(status, 'contacted')) return null;
    return {
      state: 'in_progress',
      human: `${who} ответил: берёт заявку и свяжется с человеком сам. Машина этим не закреплена, сумма не названа.`,
      next: `Дальнейшее человек согласует с ${w.ins} по телефону.`,
    };
  }
  if (answer === 'decline') {
    // Перевозчик «Не могу» ставит лиду lost, прокатчик — статус не меняет.
    if (!answerHolds(status, purpose === 'carrier' ? 'lost' : null)) return null;
    return {
      state: 'declined',
      human: `${who} ответил: выполнить заявку не может.`,
      next: `Можно: ${OTHER_OFFERS[purpose]}.`,
    };
  }
  return null;
}

/**
 * Что сказать о лиде по ответу адресата — или null, и тогда говорит статус.
 * Бронь по лиду главнее всего: она — то, что оператор сделал после ответа.
 */
function leadAnswerView(row: StatusRow, purpose: ConsentPurpose, requested: string | null): AnswerView | null {
  if (row.booking_status) return null;
  const status = row.lead_status ?? null;
  let view: AnswerView | null = null;
  const group = purpose === 'operator' && row.lead_group_over === true;
  // Закрытие с причиной — последнее слово продавца: причина стирается при
  // любой смене статуса, значит ответ кнопкой, если он был, старше.
  const closed = purpose === 'operator' ? sellerClosedView(row.lead_lost_reason, status) : null;
  if (closed) return closed;
  if (purpose === 'operator' && row.lead_answer) {
    // Большая группа после отказа адресата уходит другим операторам — это
    // не конец заявки, а передача. Кроме отказа по погоде или безопасности:
    // его крон не передаёт (lib/leads/followup-scope, GROUP_DECLINED_LEAD_SQL).
    if (group && groupPassedOnAnswer(row.lead_answer, row.lead_decline_reason ?? null)
      && answerHolds(status, row.lead_answer === 'decline' ? 'lost' : null)) {
      return { ...GROUP_PASSED_ON, human: 'Оператор тура не может взять всю группу. Заявку на группу увидят другие операторы того же вида туров.' };
    }
    view = tourAnswerView(row.lead_answer, row.lead_decline_reason ?? null, status, requested);
  } else if ((purpose === 'carrier' || purpose === 'rental') && row.lead_partner_answer) {
    view = vehicleAnswerView(row.lead_partner_answer, purpose, status);
  }
  if (view) return view;
  // Крон добивки отдал заявку менеджеру и поставил `contacted`: «оператор
  // связался» было бы неправдой — с человеком ещё никто не говорил. Почему
  // отдал, здесь не утверждается: операторов могли и не спросить.
  if (status === 'contacted' && row.lead_escalated === true) {
    return {
      state: 'in_progress',
      human: 'Заявка передана менеджеру Ведара для ручной обработки.',
      next: 'Менеджер Ведара свяжется с человеком по телефону из заявки.',
    };
  }
  // Большая группа уже передана: прежний адресат отказался, нового ещё нет.
  if (group && row.lead_declined_by && row.lead_addressed === false && status !== null
    && (UNATTENDED_LEAD_STATUSES as readonly string[]).includes(status)) {
    return { ...GROUP_PASSED_ON, human: 'Оператор тура не смог взять всю группу; заявка передана другим операторам того же вида туров.' };
  }
  return null;
}

/**
 * Ответ, после которого большую группу увидят другие операторы: «Нет мест» и
 * отказ не по погоде (тот же выбор, что GROUP_DECLINED_LEAD_SQL).
 */
export function groupPassedOnAnswer(answer: string | null | undefined, reason: string | null | undefined): boolean {
  return answer === 'no_seats' || (answer === 'decline' && reason !== 'weather');
}

/**
 * Номер ответа туроператора кнопкой, если вид заявки построен именно из него
 * (план «после отказа», 2б): тогда сообщение о нём человеку правдиво, а
 * прочтение такого вида — доставка. null — вид говорит другое (бронь, ответ
 * перерос статус, другая дата, заявка не туроператору): сообщать не о чем.
 */
export function shownTourAnswerId(row: StatusRow): string | null {
  if (!row.lead_answer_id || !row.lead_answer || row.booking_status) return null;
  if (consentPurposeOfKey(row) !== 'operator') return null;
  // Вид говорит словами закрытия с причиной — ответ кнопкой его не строит.
  if (shownSellerClosed(row)) return null;
  const status = row.lead_status ?? null;
  if (row.lead_group_over === true && groupPassedOnAnswer(row.lead_answer, row.lead_decline_reason ?? null)) {
    return answerHolds(status, row.lead_answer === 'decline' ? 'lost' : null) ? row.lead_answer_id : null;
  }
  return tourAnswerView(row.lead_answer, row.lead_decline_reason ?? null, status, null) ? row.lead_answer_id : null;
}

/**
 * Номер записи журнала с ответом перевозчика или прокатчика, если вид заявки
 * построен именно из него (план «после отказа», 2б-2): тогда сообщение о нём
 * заказчику правдиво, а прочтение такого вида — доставка. null — бронь,
 * статус перерос ответ или заявка не на машину.
 */
export function shownVehicleAnswerId(row: StatusRow): string | null {
  if (!row.lead_partner_answer_id || !row.lead_partner_answer || row.booking_status) return null;
  const purpose = consentPurposeOfKey(row);
  if (purpose !== 'carrier' && purpose !== 'rental') return null;
  return vehicleAnswerView(row.lead_partner_answer, purpose, row.lead_status ?? null) ? row.lead_partner_answer_id : null;
}

/**
 * Ответ адресата, из которого построен вид заявки, — ссылкой для сообщения
 * человеку (answer_notices): `tour` — кнопка туроператора
 * (partner_incoming_answers), `vehicle` — запись журнала перевозчика или
 * прокатчика. Два источника не пересекаются: род заявки один.
 */
export type ShownAnswerRef = { source: 'tour' | 'vehicle' | 'closed'; id: string };

/**
 * Запись журнала о закрытии продавцом с причиной, если вид заявки построен
 * именно из неё (этап 3а): тогда сообщение человеку об отказе правдиво, а
 * прочтение такого вида — доставка. null — бронь, причины нет, статус уже
 * другой или заявка не туроператору.
 */
export function shownSellerClosedId(row: StatusRow): string | null {
  return row.lead_closed_id && shownSellerClosed(row) ? row.lead_closed_id : null;
}

export function shownAnswerRef(row: StatusRow): ShownAnswerRef | null {
  const closed = shownSellerClosedId(row);
  if (closed) return { source: 'closed', id: closed };
  const tour = shownTourAnswerId(row);
  if (tour) return { source: 'tour', id: tour };
  const vehicle = shownVehicleAnswerId(row);
  return vehicle ? { source: 'vehicle', id: vehicle } : null;
}

/** Ответ владельца жилья кнопкой (1359, lib/stay/owner-answer). Это не бронь. */
function stayAnswerView(answer: string | null | undefined): AnswerView | null {
  switch (answer) {
    case 'free':
      return {
        state: 'in_progress',
        human: 'Владелец ответил: на эти даты свободно, заявку берёт. Это не бронь: даты и цену он подтвердит звонком или в переписке.',
        next: 'Дальнейшее человек согласует с владельцем по телефону.',
      };
    case 'busy':
      return {
        state: 'declined',
        human: 'Владелец ответил: на эти даты занято.',
        next: 'Другое жильё на эти даты — search_accommodations; новая заявка — create_stay_request.',
      };
    case 'call':
      return {
        state: 'in_progress',
        human: 'Владелец ответил: позвонит человеку сам.',
        next: `Подождите звонка по телефону из заявки. Если звонка долго нет, человеку стоит позвонить самому: ${STAY_CALL_SELF}`,
      };
    default:
      return null;
  }
}

function iso(v: Date | string | null): string | null {
  if (!v) return null;
  const t = v instanceof Date ? v : new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** Ключ как он передан: форма проверена, в базу не ходили. Не похож на выданный — отказ по входу. */
export function readKey(raw: unknown): string {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key.length < REQUEST_KEY_MIN_CHARS || key.length > REQUEST_KEY_MAX_CHARS || !KEY_RE.test(key)) {
    throw new McpUserError('Ключ статуса не похож на выданный — передайте его как есть из ответа пишущего инструмента.', 'invalid_args:key');
  }
  return key;
}

/** Чем ключ ищется в базе (там только hash): для дверей, которые по ключу меняют заявку (lib/mcp/change-request). */
export function requestKeyHash(key: string): string {
  return sha256(key);
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
         l.status AS lead_status, l.route_title, l.source_data->>'date' AS lead_requested_date,
         CASE WHEN l.source_data->>'participants' ~ '^[0-9]{1,2}$' THEN (l.source_data->>'participants')::int END AS lead_participants, lt.title AS lead_tour,
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
         k.opens_chat, (l.operator_id IS NOT NULL AND l.is_self = FALSE) AS lead_addressed,
         sm.n AS chat_partner_replies, sm.last_at AS chat_partner_last_at,
         (COALESCE(s.guest_max_chat_id, l.guest_max_chat_id) IS NOT NULL) AS chat_guest_on_max,
         n.ref AS notify_ref, n.disabled_reason AS notify_disabled_reason,
         pa.id::text AS lead_answer_id, pa.answer AS lead_answer, pa.decline_reason AS lead_decline_reason,
         la.answer AS lead_partner_answer, la.id AS lead_partner_answer_id,
         (l.source_data->>'escalated_to_admin') = 'true' AS lead_escalated,
         (l.source_data->>'group_over_seats') = 'true' AS lead_group_over,
         l.source_data->>'declined_by' AS lead_declined_by,
         l.source_data->>'kind' AS lead_kind,
         s.owner_answer AS stay_owner_answer,
         l.lost_reason AS lead_lost_reason, lc.id AS lead_closed_id
    FROM k
    LEFT JOIN leads l ON l.id = k.lead_id
    -- Ответ кнопкой того, кто сейчас адресат лида (1334): после передачи
    -- заявки другому ответ прежнего адресата о ней ничего не говорит.
    LEFT JOIN partner_incoming_answers pa
           ON pa.subject_kind = 'lead' AND pa.subject_id = k.lead_id::text
          AND pa.partner_id::text = l.operator_id::text
          -- …и на ту дату, что сейчас в заявке (1422): после «Нет мест» человек
          -- мог сам выбрать другую, и ответ о прежней дате о новой не говорит.
          -- Уникальность (предмет, партнёр, дата) — не больше строки на ключ.
          AND pa.subject_date IS NOT DISTINCT FROM ${LEAD_ANSWER_DATE_SQL('l')}
    LEFT JOIN LATERAL (
      SELECT pal.id::text AS id, pal.details->>'answer' AS answer
        FROM lead_activity_log pal
       WHERE pal.lead_id = k.lead_id AND pal.action = 'partner_answered'
       ORDER BY pal.id DESC
       LIMIT 1
    ) la ON k.lead_id IS NOT NULL
    -- Закрытие продавцом с причиной (1429): причина лежит в заявке и стирается
    -- при смене статуса, поэтому последняя запись журнала — её закрытие.
    LEFT JOIN LATERAL (
      SELECT cl.id::text AS id
        FROM lead_activity_log cl
       WHERE cl.lead_id = k.lead_id AND cl.action = '${SELLER_CLOSED_ACTION}'
       ORDER BY cl.id DESC
       LIMIT 1
    ) lc ON l.lost_reason IS NOT NULL
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
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n, max(m.created_at) AS last_at
        FROM request_messages m
       WHERE m.author = 'owner' AND (m.stay_request_id = k.stay_request_id OR m.lead_id = k.lead_id)
    ) sm ON k.opens_chat
    LEFT JOIN agent_request_notify n ON n.key_id = k.id`;

/** По ключу: живой ключ → отметка прочтения и строка заявки. Это читает агент. */
export const REQUEST_STATUS_SQL = `
  WITH k AS (
    UPDATE agent_request_keys
       SET last_read_at = NOW(), read_count = read_count + 1
     WHERE key_hash = $1 AND expires_at > NOW()
    RETURNING id, lead_id, seat_request_id, stay_request_id, tool_name,
              -- Ключ жилья открывает переписку всегда: склейки у жилья нет (1350).
              (opens_chat OR stay_request_id IS NOT NULL) AS opens_chat
  )${REQUEST_STATUS_SELECT}`;

/**
 * По номерам ключей, без отметки прочтения: так читает сверка уведомлений.
 * Сырого ключа у неё нет и быть не должно, а прочтение — это обращение
 * агента, не наше.
 */
export const REQUEST_STATUS_BY_KEY_IDS_SQL = `
  WITH k AS (
    SELECT id, lead_id, seat_request_id, stay_request_id, tool_name,
           (opens_chat OR stay_request_id IS NOT NULL) AS opens_chat
      FROM agent_request_keys
     WHERE id = ANY($1::uuid[]) AND expires_at > NOW()
  )${REQUEST_STATUS_SELECT}`;

/**
 * По номеру заявки, без сырого ключа и без отметки прочтения: так читает
 * сообщение человеку после ответа оператора (lib/requests/answer-notice).
 * Ключ — новой заявки, если он есть; заявки без ключа (форма до 1350) читаются
 * как `handoff:none`: род берётся по самой заявке (consentPurposeOfKey), а не
 * по умолчанию «подбор».
 */
const statusByLeads = (leads: string): string => `
  WITH k AS (
    SELECT kk.id, x.lead_id, NULL::uuid AS seat_request_id, NULL::uuid AS stay_request_id,
           COALESCE(kk.tool_name, 'handoff:none') AS tool_name, COALESCE(kk.opens_chat, false) AS opens_chat
      FROM (${leads}) x
      LEFT JOIN LATERAL (
        SELECT id, tool_name, opens_chat FROM agent_request_keys
         WHERE lead_id = x.lead_id AND expires_at > NOW()
         ORDER BY opens_chat DESC, created_at
         LIMIT 1
      ) kk ON TRUE
  )${REQUEST_STATUS_SELECT}`;

export const REQUEST_STATUS_BY_LEAD_SQL = statusByLeads('SELECT $1::uuid AS lead_id');

/**
 * То же по списку заявок одним запросом — строка на заявку, `lead_id` в ней.
 * Так очередь менеджера (lib/manager-queue) сверяет, что вид каждой заявки
 * по-прежнему построен из отказа, по которому человеку собираются звонить.
 */
export const REQUEST_STATUS_BY_LEADS_SQL = statusByLeads('SELECT DISTINCT unnest($1::uuid[]) AS lead_id');

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

/**
 * Вид заявки без страницы человека: его собирают и агенту, и сверке
 * уведомлений. Ссылки с ключом (страница, MAX) — только в ответе по ключу:
 * сырого ключа у сверки нет и быть не должно.
 */
export type RequestCore = Omit<RequestStatusView, 'page' | 'notify' | 'max_link'>;

/** Переписки у запроса мест нет: поля есть, значения null. */
const NO_CHAT = { partner_replies: null, partner_last_reply_at: null } as const;

/**
 * Адресат уже ответил в переписке. Те же слова уходят и в уведомление (поле
 * next), а в его теле нет ни страницы, ни ссылки MAX — поэтому текст отсылает
 * к ответу get_request_status, а не к полям этого же ответа.
 */
const CHAT_REPLIED_NEXT = 'Дайте человеку страницу заявки из ответа get_request_status: там ответ, и ответить можно там же или в MAX.';

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
  const consent_purpose = consentPurposeOfKey(row);

  if (row.stay_request_id) {
    // Строки заявки нет (удалена между UPDATE и JOIN) — честное unknown.
    const exists = row.stay_accommodation_id !== null;
    const delivery = stayDelivery(row.stay_owner_channel, row.stay_platform_channel, row.stay_delivery_recorded_at);
    // Ответ владельца кнопкой (1359) — главнее доставки: заявка до него дошла.
    const answered = exists ? stayAnswerView(row.stay_owner_answer) : null;
    const state = answered ? answered.state : exists ? stayState(delivery) : 'unknown';
    // Переписка (1349): сколько написал владелец — без текста.
    const chat = exists && row.opens_chat === true;
    const replies = Number(row.chat_partner_replies ?? 0);
    const stayHuman = answered ? answered.human : STAY_HUMAN[delivery];
    const stayNext = answered ? answered.next : STAY_NEXT[delivery];
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
      human: !exists ? HUMAN.unknown
        : chat && replies > 0 ? `${stayHuman} Владелец уже ответил в переписке (сообщений: ${replies}); текст — на странице заявки, здесь он не показывается.`
        : stayHuman,
      next: !exists ? NEXT.unknown
        : chat && replies > 0 ? (answered ? `${stayNext} ${CHAT_REPLIED_NEXT}` : CHAT_REPLIED_NEXT)
        : stayNext,
      consent: consentBy(row.stay_consent_source, row.stay_consent_at),
      consent_purpose,
      partner_replies: chat ? replies : null,
      partner_last_reply_at: chat ? iso(row.chat_partner_last_at ?? null) : null,
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
          next: NEXT[state], consent, consent_purpose, ...NO_CHAT,
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
        next: NEXT[state], consent, consent_purpose, ...NO_CHAT,
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
      ...NO_CHAT,
    };
  }

  // Лид без строки lead: сама заявка удалена (ON DELETE CASCADE снял бы и
  // ключ, но строка могла исчезнуть между UPDATE и JOIN) — честное unknown.
  // Запрошенная дата есть только у заявки на бронь тура (её пишет роут MCP в
  // source_data); у подбора, машины и проката даты в этом смысле нет.
  const requested = row.tool_name === BOOKING_TOOL_NAME ? dayOrNull(row.lead_requested_date) : null;
  // Ответ адресата кнопкой — пока статус лида его не перерос (leadAnswerView).
  const answered = row.lead_id && row.lead_status !== null ? leadAnswerView(row, consent_purpose, requested) : null;
  const state = answered ? answered.state : row.lead_id ? leadState(row.lead_status, row.booking_status) : 'unknown';
  // Переписка с адресатом лида (1350): только ключ новой заявки и только лид,
  // адресованный партнёру. Без текста — число и время ответов.
  const chat = row.lead_id !== null && row.lead_status !== null && row.opens_chat === true && row.lead_addressed === true;
  const replies = Number(row.chat_partner_replies ?? 0);
  // Отменил клиент (1427): брони нет, и «бронь по заявке отменена» было бы неправдой.
  const clientCancelled = !answered && !row.booking_status && row.lead_status === LEAD_CLIENT_CANCELLED;
  const human = answered
    ? answered.human
    : clientCancelled
      ? CLIENT_CANCELLED_HUMAN
      : humanText(state, consent_purpose) + (row.booking_status ? dateChangeNote(requested, row.booking_date) : '');
  return {
    state,
    kind: 'lead',
    tour: row.booking_tour ?? leadCatalogTour(row) ?? row.route_title,
    accommodation: null,
    accommodation_url: null,
    date: row.booking_date,
    requested_date: requested,
    check_out: null,
    participants: row.booking_participants ?? row.lead_participants ?? null,
    alt_date: null,
    deadline: null,
    human: chat && replies > 0
      ? `${human} Адресат заявки ответил в переписке (сообщений: ${replies}); текст — на странице заявки, здесь он не показывается.`
      : human,
    next: answered
      ? (chat && replies > 0 ? `${answered.next} ${CHAT_REPLIED_NEXT}` : answered.next)
      : chat && replies > 0 ? CHAT_REPLIED_NEXT : nextText(state, consent_purpose),
    consent: consentBy(row.lead_consent_source, row.lead_consent_at),
    consent_purpose,
    partner_replies: chat ? replies : null,
    partner_last_reply_at: chat ? iso(row.chat_partner_last_at ?? null) : null,
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

/**
 * Кто читает статус. `agent` — get_request_status (MCP, A2A); `page` —
 * страница заявки, `seen` — вкладка на виду; без `reader` — чтение не
 * считается доставкой ответа (Кузьмич по вставленному ключу: человек спросил
 * сам, сообщение ему ушло бы и так).
 */
export interface StatusReader { reader?: 'agent' | 'page'; seen?: boolean }

export async function readRequestStatus(rawKey: unknown, opts: StatusReader = {}): Promise<RequestStatusView> {
  const key = readKey(rawKey);
  // Пробный ключ не хранится — заявки нет (lib/mcp/test-run, 08.11).
  if (isTestKey(key)) return testKeyStatus(key);
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
  const core = buildRequestView(row, Date.now());
  // Ответ оператора дошёл, если его прочитал держатель ключа новой заявки
  // (план «после отказа», 2б; слово владельца 11.11 «мы доверяем агенту»).
  const shown = row.opens_chat === true ? shownAnswerRef(row) : null;
  const via = opts.reader === 'agent' ? 'agent_read' : opts.reader === 'page' && opts.seen === true ? 'page_seen' : null;
  if (shown && via) {
    const { markShownRef } = await import('@/lib/requests/answer-notice-mark');
    await markShownRef(shown, via);
  }
  return {
    ...core,
    page: requestStatusPageUrl(key),
    // Подключить MAX клиента (1349, 1350): ссылку строит сырой ключ, он есть
    // только здесь. Переписка по ключу открыта — partner_replies не null.
    max_link: core.partner_replies !== null && row.chat_guest_on_max !== true ? guestBotLink(maxBot(), key) : null,
    notify: notifyStatusOf(row),
  };
}

export type ConfirmOutcome = 'recorded' | 'already' | 'gone';

/**
 * Один запрос: ключ живой → согласие человека пишется в лид, запрос мест или
 * заявку на жильё ПОВЕРХ записи агента (основание сильнее — его и храним; факт вызова агента
 * остаётся в журнале mcp_tool_calls) или туда, где согласия нет вовсе. Согласие
 * человека — на странице заявки или галочкой формы — не трогается: первое
 * подтверждение и есть доказательство. С 1350 ключ выдаёт и форма сайта, и
 * повтор заявки (тот же телефон) получает свой ключ: перезапиши подтверждение
 * страницы чужое согласие с формы — держатель ключа повтора заменил бы адрес и
 * время, которыми человек сам дал согласие (ревью 30.10). Подзапросы к
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
     WHERE id = (SELECT lead_id FROM k) AND (pd_consent_at IS NULL OR pd_consent_source = $6::varchar)
    RETURNING id
  ), r AS (
    UPDATE tour_seat_requests
       SET pd_consent_at = $2::timestamptz, pd_consent_ip = $3::varchar, pd_consent_source = $4::varchar, pd_consent_version = $5::varchar
     WHERE id = (SELECT seat_request_id FROM k) AND (pd_consent_at IS NULL OR pd_consent_source = $6::varchar)
    RETURNING id
  ), s AS (
    UPDATE stay_requests
       SET pd_consent_at = $2::timestamptz, pd_consent_ip = $3::varchar, pd_consent_source = $4::varchar, pd_consent_version = $5::varchar
     WHERE id = (SELECT stay_request_id FROM k) AND (pd_consent_at IS NULL OR pd_consent_source = $6::varchar)
    RETURNING id
  )
  SELECT ((SELECT COUNT(*) FROM l) + (SELECT COUNT(*) FROM r) + (SELECT COUNT(*) FROM s))::int AS updated,
         (SELECT COUNT(*) FROM l)::int AS lead_updated,
         lp.id::text AS lead_id,
         COALESCE(lp.pd_consent_source, rp.pd_consent_source, sp.pd_consent_source) AS prior_source,
         (lp.id IS NOT NULL OR rp.id IS NOT NULL OR sp.id IS NOT NULL) AS target_exists
    FROM k
    LEFT JOIN leads lp ON lp.id = k.lead_id
    LEFT JOIN tour_seat_requests rp ON rp.id = k.seat_request_id
    LEFT JOIN stay_requests sp ON sp.id = k.stay_request_id`;

interface ConfirmRow {
  updated: number;
  /** Сколько строк leads переписано этой командой (0 или 1). */
  lead_updated?: number;
  lead_id?: string | null;
  prior_source: string | null;
  target_exists: boolean;
}

/**
 * Человек подтвердил согласие на странице заявки. Ключ не найден или истёк —
 * отказ по входу (McpUserError), как у чтения; база не ответила — исключение
 * с SQLSTATE в логе, а не «записано».
 */
export async function confirmConsent(rawKey: unknown, record: PdConsentRecord): Promise<ConfirmOutcome> {
  const key = readKey(rawKey);
  let row: ConfirmRow | undefined;
  try {
    ({ rows: [row] } = await pool.query<ConfirmRow>(CONFIRM_CONSENT_SQL, [sha256(key), record.at, record.ip, record.source, record.version, AGENT_CONSENT_SOURCE]));
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[request-status] согласие не записано:', typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    throw new Error('request-status: согласие не записано');
  }
  if (!row) {
    throw new McpUserError(`Ключ не найден или истёк (ключ живёт ${REQUEST_KEY_TTL_DAYS} дней).`, 'key_not_found');
  }
  if (row.updated > 0) {
    // Лид агента подтвердил человек (05.11): менеджеру — отдельным сообщением,
    // иначе пометка «человек не подтвердил» у лида в рабочем чате оставалась
    // навсегда. Заявки на места и жильё уходят адресату сами и сюда не входят.
    if (row.lead_id && Number(row.lead_updated ?? 0) > 0) await notifyLeadHumanConfirmedQuietly(row.lead_id);
    return 'recorded';
  }
  return row.target_exists ? 'already' : 'gone';
}

/** Род заявки по ключу без отметки прочтения: какой текст согласия человек подтверждает. */
export const CONSENT_PURPOSE_SQL = `
  SELECT k.tool_name, k.stay_request_id::text AS stay_request_id, l.source_data->>'kind' AS lead_kind
    FROM agent_request_keys k
    LEFT JOIN leads l ON l.id = k.lead_id
   WHERE k.key_hash = $1 AND k.expires_at > NOW()`;

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
    ({ rows: [row] } = await pool.query<{ tool_name: string; stay_request_id: string | null; lead_kind: string | null }>(CONSENT_PURPOSE_SQL, [sha256(key)]));
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[request-status] род заявки не прочитан:', typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    throw new Error('request-status: род заявки не прочитан');
  }
  if (!row) {
    throw new McpUserError(`Ключ не найден или истёк (ключ живёт ${REQUEST_KEY_TTL_DAYS} дней).`, 'key_not_found');
  }
  return consentPurposeOfKey(row);
}

/** Исполнитель для роута MCP: JSON-строка того же объекта (как у search/fetch). */
export async function runRequestStatusTool(rawArgs: Record<string, unknown>): Promise<string> {
  return JSON.stringify(await readRequestStatus(rawArgs.key, { reader: 'agent' }));
}
