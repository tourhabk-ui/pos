/**
 * lib/requests/answer-notice.ts — сообщение человеку после ответа
 * туроператора кнопкой (план «после отказа», этап 2б-1; слово владельца 11.11:
 * «карт-бланш по плану действуй», «мы доверяем агенту»).
 *
 * До этой правки «Нет мест», «Отказать» и «Другая дата» туристу не уходили
 * никак — ответ видел только тот, кто сам открыл статус. Теперь сразу в
 * нажатии оператора:
 *  1. вид заявки по-прежнему построен из этого ответа (shownTourAnswerId) —
 *     иначе сообщать не о чем: бронь, новая дата, ответ перерос статус;
 *  2. чаты человека — те, что вправе нажимать даты этой заявки: связь чата с
 *     ключом НОВОЙ заявки (`opens_chat`), `guest_max_chat_id`, Telegram старых
 *     потоков бота; первое принятое сообщение — доставка, больше одного
 *     сообщения на ответ не уходит;
 *  3. никто из чатов не принял, а у ключа новой заявки живая подписка ИИ-агента
 *     — внеочередная сверка этой подписки тем же захватом, что у крона;
 *  4. иначе — «не доставлено», и менеджеру Ведара сразу, без таймеров: имя и
 *     телефон только в MAX (sendPdAlert), заглушка без ПД.
 * Прочтение статуса агентом или страницей на виду — тоже доставка
 * (answer-notice-mark); если оно пришло после письма менеджеру, добивка
 * пишет ему «звонить не нужно».
 *
 * Доставка «хотя бы раз», не «ровно один»: захват на 5 минут ставится при
 * вставке, на каждую отправку — не дольше 20 с; упади процесс между отправкой
 * и записью исхода — добивка отправит ещё раз.
 *
 * Логи — номер заявки, канал и код. Ни id чатов, ни текста ошибок MAX (там
 * может быть id), ни имени и телефона.
 */
import { pool } from '@/lib/db-pool';
import { getPublicBaseUrl } from '@/lib/config';
import { tourPath } from '@/lib/tours/tour-url';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { loadFreeDatesNear, type FreeDates } from '@/lib/tours/nearest-free-date';
import { LEAD_ANSWER_DATE_SQL } from '@/lib/requests/answer-date';
import { DECLINE_REASONS, type DeclineReason } from '@/lib/requests/chat-answer-buttons';
import { REQUEST_STATUS_BY_LEAD_SQL, groupPassedOnAnswer, shownTourAnswerId, type StatusRow } from '@/lib/mcp/request-status';
import {
  answerWantsDates, managerClearedText, managerUndeliveredText, touristAnswerText,
  type DatesBlock, type NoticeAnswer, type NoticeFacts, type NoticeOutcome,
} from '@/lib/requests/answer-notice-text';
import type { PdAlertParams, PdAlertResult } from '@/lib/notifications/pd-alert';

const LOG = '[answer-notice]';
/** Больше 20 с на одну отправку нажатие оператора не ждёт; захват — 5 минут. */
export const NOTICE_SEND_TIMEOUT_MS = 20_000;
/** Сколько дат рядом показать. */
export const NOTICE_DATES = 4;
/** После стольких захватов «ждёт» добивка не шлёт человеку ещё раз — менеджеру. */
export const NOTICE_MAX_TRIES = 3;
/** Больше стольких попыток добивка строку не берёт — её называет сторож. */
export const NOTICE_MAX_ATTEMPTS = 12;
export const NOTICE_RUN_LIMIT = 20;
export const NOTICE_RUN_TIME_BUDGET_MS = 45_000;

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
type Button = { text: string; payload: string };
type SendResult = { ok: true } | { ok: false; code: string };

export interface NoticeDeps {
  query?: Query;
  sendMax?: (chatId: string, text: string, buttons: Button[]) => Promise<SendResult>;
  sendTelegram?: (chatId: string, text: string, buttons: Button[]) => Promise<SendResult>;
  pdAlert?: (p: PdAlertParams) => Promise<PdAlertResult>;
  /** Внеочередная сверка подписок этих ключей (request-notify, onlyKeyIds). */
  notifyRun?: (keyIds: string[]) => Promise<unknown>;
  freeDates?: typeof loadFreeDatesNear;
  now?: () => number;
}

// ── SQL ──────────────────────────────────────────────────────────────────────

const TOUR_ID_SQL = `CASE WHEN l.source_data->>'tour_id' ~ '^[0-9]{1,18}$' THEN (l.source_data->>'tour_id')::bigint END`;

/** Строка сообщения и факты заявки для слов — без имени и телефона. */
export const NOTICE_FACTS_SQL = `
  SELECT n.id::text AS id, n.lead_id::text AS lead_id, n.answer_id::text AS answer_id, n.answer, n.decline_reason,
         n.state, n.skipped_reason, n.delivered_via, n.tried, n.attempts, n.manager_channel,
         (n.manager_alerted_at IS NOT NULL) AS manager_alerted, (n.manager_cleared_at IS NOT NULL) AS manager_cleared,
         ${LEAD_ANSWER_DATE_SQL('l')} AS lead_date,
         CASE WHEN l.source_data->>'participants' ~ '^[0-9]{1,3}$' THEN (l.source_data->>'participants')::int END AS people,
         ${TOUR_ID_SQL} AS tour_id,
         ot.title AS tour_title, ot.slug AS tour_slug, COALESCE(${publicTourSql('ot')}, false) AS tour_public,
         p.name AS operator_name,
         (COALESCE(l.comment, '') LIKE '%[Поездка %') AS trip_part,
         ARRAY(SELECT pa_r.subject_date FROM partner_incoming_answers pa_r
                WHERE pa_r.subject_kind = 'lead' AND pa_r.subject_id = l.id::text
                  AND pa_r.partner_id = l.operator_id AND pa_r.answer = 'no_seats'
                  AND pa_r.subject_date IS NOT NULL) AS refused_dates
    FROM answer_notices n
    JOIN leads l ON l.id = n.lead_id
    JOIN partner_incoming_answers pa ON pa.id = n.answer_id
    LEFT JOIN operator_tours ot ON ot.id = ${TOUR_ID_SQL}
    LEFT JOIN partners p ON p.id = pa.partner_id
   WHERE n.id = $1::bigint`;

/**
 * Чаты человека. Связь чата — только через ключ НОВОЙ заявки (`opens_chat`):
 * ключ повтора получает любой, кто знает чужой телефон, тур и дату. Плюс
 * `guest_max_chat_id` (туда уже уходят слова адресата) и Telegram старых
 * потоков бота. Пара (канал, чат) — один раз. `can_pick` — тот же признак,
 * что у «Изменить дату» (MY_TRIP_DATE_LEAD_SQL): нажатие даты там пройдёт.
 */
export const NOTICE_TARGETS_SQL = `
  WITH k AS (
    SELECT id, tool_name, created_at FROM agent_request_keys
     WHERE lead_id = $1::uuid AND expires_at > NOW() AND opens_chat
  ), t AS (
    SELECT c.channel, c.chat_id, CASE c.origin WHEN 'created' THEN 0 ELSE 1 END AS rank,
           (k.tool_name = 'create_booking_request') AS pick, k.created_at
      FROM chat_request_links c JOIN k ON k.id = c.key_id
    UNION ALL
    SELECT 'max', l.guest_max_chat_id::text, 2, false, NULL FROM leads l
     WHERE l.id = $1::uuid AND l.guest_max_chat_id IS NOT NULL
    UNION ALL
    SELECT 'telegram', l.telegram_chat_id::text, 3, false, NULL FROM leads l
     WHERE l.id = $1::uuid AND COALESCE(l.telegram_chat_id, '') <> ''
  )
  SELECT channel, chat_id, bool_or(pick) AS can_pick
    FROM t
   GROUP BY channel, chat_id
   ORDER BY min(rank), max(created_at) DESC NULLS LAST`;

/** Ключи новой заявки с живой подпиской ИИ-агента. */
export const NOTICE_AGENT_KEYS_SQL = `
  SELECT k.id::text AS key_id, n.last_error
    FROM agent_request_keys k
    JOIN agent_request_notify n ON n.key_id = k.id
   WHERE k.lead_id = $1::uuid AND k.expires_at > NOW() AND k.opens_chat AND n.disabled_at IS NULL`;

/** Имя и телефон — только для письма менеджеру в MAX. */
export const NOTICE_CONTACT_SQL = `SELECT name, phone FROM leads WHERE id = $1::uuid`;

export const NOTICE_DELIVERED_SQL = `
  UPDATE answer_notices
     SET state = 'delivered', delivered_via = $2::text, tried = $3::text,
         decided_at = COALESCE(decided_at, NOW()), claimed_until = NULL
   WHERE id = $1::bigint AND state IN ('pending', 'undelivered')
  RETURNING id`;

/** Захват держится до записи канала менеджера: добивка не возьмёт строку и не пошлёт второе письмо. */
export const NOTICE_UNDELIVERED_SQL = `
  UPDATE answer_notices
     SET state = 'undelivered', tried = $2::text, decided_at = NOW(), claimed_until = NOW() + INTERVAL '5 minutes'
   WHERE id = $1::bigint AND state = 'pending'
  RETURNING id`;

export const NOTICE_SKIPPED_SQL = `
  UPDATE answer_notices
     SET state = 'skipped', skipped_reason = $2::text, decided_at = NOW(), claimed_until = NULL
   WHERE id = $1::bigint AND state = 'pending'`;

/** «Дошло» ставится только при канале, куда письмо ушло. */
export const NOTICE_MANAGER_SQL = `
  UPDATE answer_notices
     SET manager_channel = $2::text,
         manager_alerted_at = CASE WHEN $2::text <> 'none' THEN NOW() ELSE manager_alerted_at END,
         claimed_until = NULL
   WHERE id = $1::bigint`;

export const NOTICE_CLEARED_SQL = `
  UPDATE answer_notices SET manager_cleared_at = NOW(), claimed_until = NULL
   WHERE id = $1::bigint AND state = 'delivered' AND manager_cleared_at IS NULL`;

/**
 * Добивка: обрыв посреди отправки (`pending` после захвата), недоставленное,
 * о котором менеджеру ничего не дошло, и дошедшее после письма менеджеру —
 * «звонить не нужно». Захват — тем же UPDATE, параллельный прогон строку не возьмёт.
 */
export const NOTICE_CLAIM_DUE_SQL = `
  UPDATE answer_notices n SET claimed_until = NOW() + INTERVAL '5 minutes', attempts = n.attempts + 1
   WHERE n.id IN (
     SELECT id FROM answer_notices
      WHERE attempts < ${NOTICE_MAX_ATTEMPTS}
        AND (claimed_until IS NULL OR claimed_until < NOW())
        AND (state = 'pending'
             OR (state = 'undelivered' AND (manager_channel IS NULL OR manager_channel = 'none'))
             OR (state = 'delivered' AND manager_alerted_at IS NOT NULL AND manager_cleared_at IS NULL))
      ORDER BY created_at
      LIMIT ${NOTICE_RUN_LIMIT}
      FOR UPDATE SKIP LOCKED)
  RETURNING n.id::text AS id, n.state, n.attempts`;

/**
 * Застрявшее (сторож Watchdog): «ждёт» дольше цикла добивки с захватом — ни
 * нажатие, ни добивка не довели; «не доставлено», а менеджеру не дошло ничего.
 * 35 минут — 30 минут цикла добивки плюс 5 минут захвата, а не срок для
 * человека: о недоставке менеджер узнаёт сразу в нажатии.
 */
export const NOTICE_STUCK_SQL = `
  SELECT COUNT(*)::text AS count, string_agg(left(lead_id::text, 8), ',' ORDER BY created_at) AS ids
    FROM answer_notices
   WHERE (state = 'pending' AND claimed_until < NOW() - INTERVAL '35 minutes')
      OR (state = 'undelivered' AND (manager_channel IS NULL OR manager_channel = 'none')
          AND decided_at < NOW() - INTERVAL '35 minutes')`;

// ── Строка и исход ───────────────────────────────────────────────────────────

interface NoticeRow {
  id: string;
  lead_id: string;
  answer_id: string;
  answer: NoticeAnswer;
  decline_reason: string | null;
  state: 'pending' | 'delivered' | 'undelivered' | 'skipped';
  skipped_reason: 'lead_closed' | 'not_addressee' | 'self' | 'outgrown' | null;
  delivered_via: 'max' | 'telegram' | 'agent_webhook' | 'agent_read' | 'page_seen' | null;
  tried: string | null;
  attempts: number;
  manager_channel: 'max' | 'telegram-stub' | 'none' | null;
  manager_alerted: boolean;
  manager_cleared: boolean;
  lead_date: string | null;
  people: number | null;
  tour_id: string | number | null;
  tour_title: string | null;
  tour_slug: string | null;
  tour_public: boolean;
  operator_name: string | null;
  trip_part: boolean;
  refused_dates: string[] | null;
}

function codeOf(err: unknown): string {
  const c = (err as { code?: unknown })?.code;
  return typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c) ? c : 'нет';
}

/**
 * Код отправки — из белого списка: он ляжет в `tried` (CHECK 1423) и в лог.
 * Свободный текст ошибки канала мог бы нести id чата — его сюда не пускаем.
 */
const CHAT_CODES = new Set(['no_token', 'bad_id', 'api_error', 'timeout', 'exception']);
function chatCode(v: string): string {
  return CHAT_CODES.has(v) ? v : 'api_error';
}

/** Код отказа приёмника агента — форма 1348 (`http_503`, `timeout`, `dns_failed`…), без длинных чисел. */
function agentCode(v: string | null | undefined): string {
  return typeof v === 'string' && /^(http_\d{3}|[a-z_]{1,40})$/.test(v) ? v : 'not_accepted';
}

/** Исход по записанной строке — для повторного нажатия и после чужой записи. */
export function outcomeOfRow(r: Pick<NoticeRow, 'state' | 'skipped_reason' | 'delivered_via' | 'tried' | 'manager_channel'>): NoticeOutcome {
  switch (r.state) {
    case 'delivered':
      return { state: 'delivered', via: r.delivered_via ?? 'max', dates: [] };
    case 'undelivered':
      return {
        state: 'undelivered',
        manager: r.manager_channel ?? 'none',
        hadChat: (r.tried ?? '').split(',').some((t) => t.startsWith('max:') || t.startsWith('telegram:')),
      };
    case 'skipped':
      return { state: 'skipped', reason: r.skipped_reason ?? 'outgrown' };
    default:
      return { state: 'pending' };
  }
}

async function readRow(q: Query, id: string): Promise<NoticeRow | null> {
  const { rows: [row] } = await q(NOTICE_FACTS_SQL, [id]);
  return (row as NoticeRow | undefined) ?? null;
}

function isDeclineReason(v: unknown): v is DeclineReason {
  return typeof v === 'string' && (DECLINE_REASONS as readonly string[]).includes(v);
}

function factsOf(r: NoticeRow, st: StatusRow | undefined): NoticeFacts {
  const reason = isDeclineReason(r.decline_reason) ? r.decline_reason : null;
  return {
    leadId: r.lead_id,
    answer: r.answer,
    reason,
    tourTitle: r.tour_title,
    tourUrl: r.tour_public && r.tour_id !== null ? `${getPublicBaseUrl()}${tourPath({ id: r.tour_id, slug: r.tour_slug })}` : null,
    date: r.lead_date,
    people: r.people && r.people > 0 ? Number(r.people) : null,
    operatorName: r.operator_name,
    groupPassedOn: st?.lead_group_over === true && groupPassedOnAnswer(r.answer, r.decline_reason),
  };
}

/** Свободные даты рядом с датой заявки — без текущей и без прежних «Нет мест». */
async function datesOf(r: NoticeRow, f: NoticeFacts, load: typeof loadFreeDatesNear): Promise<DatesBlock> {
  if (!answerWantsDates(f)) return { kind: 'skip' };
  const tourId = r.tour_id === null ? NaN : Number(r.tour_id);
  // Тура нет на витрине — других его дат не предлагаем: заявку на них не оставить.
  if (!Number.isFinite(tourId) || !r.tour_public || !r.lead_date) return { kind: 'skip' };
  const exclude = [r.lead_date, ...(r.refused_dates ?? [])];
  const free: FreeDates = await load(tourId, f.people ?? 1, r.lead_date, exclude, NOTICE_DATES);
  if (free.state === 'failed') return { kind: 'failed' };
  if (!free.hasCalendar) return { kind: 'no_calendar' };
  return free.dates.length > 0 ? { kind: 'dates', dates: free.dates.map((d) => d.date) } : { kind: 'none' };
}

// ── Отправка ─────────────────────────────────────────────────────────────────

function withTimeout(p: Promise<SendResult>, ms: number): Promise<SendResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<SendResult>((resolve) => { timer = setTimeout(() => resolve({ ok: false, code: 'timeout' }), ms); });
  return Promise.race([p.catch((): SendResult => ({ ok: false, code: 'exception' })), late]).finally(() => clearTimeout(timer));
}

async function defaultSendMax(chatId: string, text: string, buttons: Button[]): Promise<SendResult> {
  const { maxSendDm } = await import('@/lib/notifications/max-channel');
  const r = await maxSendDm(chatId, text, buttons.length > 0 ? { buttons } : undefined);
  if (r.ok) return { ok: true };
  // Текст ошибки MAX в лог не идёт: там может быть id чата. Только род.
  const e = r.error ?? '';
  return { ok: false, code: e.includes('MAX_BOT_TOKEN') ? 'no_token' : e === 'invalid chat_id' ? 'bad_id' : 'api_error' };
}

async function defaultSendTelegram(chatId: string, text: string, buttons: Button[]): Promise<SendResult> {
  const { telegramService } = await import('@/lib/notifications/telegram');
  const r = await telegramService.sendMessage({
    chatId, text, parseMode: 'HTML',
    ...(buttons.length > 0 ? { replyMarkup: { inline_keyboard: buttons.map((b) => [{ text: b.text, callback_data: b.payload }]) } } : {}),
  });
  return r.success ? { ok: true } : { ok: false, code: 'api_error' };
}

async function defaultPdAlert(p: PdAlertParams): Promise<PdAlertResult> {
  const { sendPdAlert } = await import('@/lib/notifications/pd-alert');
  return sendPdAlert(p);
}

async function defaultNotifyRun(keyIds: string[]): Promise<unknown> {
  const { runRequestNotify } = await import('@/lib/mcp/request-notify');
  return runRequestNotify({ onlyKeyIds: keyIds, timeBudgetMs: 12_000 });
}

/** Менеджеру: до человека не дошло. Канал письма — в строку; «дошло» — только при канале. */
async function alertManager(q: Query, r: NoticeRow, f: NoticeFacts, tried: string[], dates: string[], deps: NoticeDeps): Promise<'max' | 'telegram-stub' | 'none'> {
  let channel: 'max' | 'telegram-stub' | 'none' = 'none';
  try {
    const { rows: [c] } = await q(NOTICE_CONTACT_SQL, [r.lead_id]);
    const contact = (c ?? {}) as { name?: string | null; phone?: string | null };
    const msg = managerUndeliveredText(f, { name: contact.name ?? null, phone: contact.phone ?? null }, tried, dates);
    const res = await (deps.pdAlert ?? defaultPdAlert)({
      text: msg.text,
      stub: msg.stub,
      buttons: [{ text: 'Заявки в админке', url: `${getPublicBaseUrl()}/hub/admin/leads` }],
    });
    channel = res.channel === 'max' && res.delivered ? 'max' : res.channel === 'telegram-stub' ? 'telegram-stub' : 'none';
    if (channel === 'none') console.error(`${LOG} заявка ${r.lead_id}: менеджеру не дошло (${res.channel}) — повторит добивка`);
  } catch (err) {
    console.error(`${LOG} заявка ${r.lead_id}: письмо менеджеру не собрано, SQLSTATE`, codeOf(err));
  }
  await q(NOTICE_MANAGER_SQL, [r.id, channel]);
  return channel;
}

/**
 * Отправить сообщение по одной строке «ждёт». Никогда не бросает: сбой — исход
 * `pending`, строку подберёт добивка после захвата.
 */
export async function deliverAnswerNotice(noticeId: string, deps: NoticeDeps = {}): Promise<NoticeOutcome> {
  const q: Query = deps.query ?? ((sql, params) => pool.query(sql, params));
  let leadId = '?';
  try {
    const r = await readRow(q, noticeId);
    if (!r) return { state: 'pending' };
    leadId = r.lead_id;
    if (r.state !== 'pending') return outcomeOfRow(r);

    // 1. Вид заявки построен из этого ответа — иначе сообщать не о чем.
    const { rows: [st] } = await q(REQUEST_STATUS_BY_LEAD_SQL, [r.lead_id]);
    const status = st as StatusRow | undefined;
    if (!status || shownTourAnswerId(status) !== r.answer_id) {
      await q(NOTICE_SKIPPED_SQL, [r.id, 'outgrown']);
      return outcomeOfRow((await readRow(q, noticeId)) ?? { ...r, state: 'skipped', skipped_reason: 'outgrown' });
    }
    const f = factsOf(r, status);
    const dates = await datesOf(r, f, deps.freeDates ?? loadFreeDatesNear);
    const shownDates = dates.kind === 'dates' ? dates.dates : [];

    // 2. Чаты человека — первое принятое сообщение и есть доставка.
    const tried: string[] = [];
    const targets = (await q(NOTICE_TARGETS_SQL, [r.lead_id])).rows as Array<{ channel: 'max' | 'telegram'; chat_id: string; can_pick: boolean }>;
    for (const t of targets) {
      const msg = touristAnswerText(f, dates, t.can_pick === true && !r.trip_part);
      const send = t.channel === 'max' ? (deps.sendMax ?? defaultSendMax) : (deps.sendTelegram ?? defaultSendTelegram);
      const res = await withTimeout(send(String(t.chat_id), msg.text, msg.buttons), NOTICE_SEND_TIMEOUT_MS);
      if (res.ok) {
        await q(NOTICE_DELIVERED_SQL, [r.id, t.channel, tried.join(',') || null]);
        console.info(`${LOG} заявка ${r.lead_id}: доставлено (${t.channel})`);
        return { state: 'delivered', via: t.channel, dates: shownDates };
      }
      const code = res.ok ? 'api_error' : chatCode(res.code);
      tried.push(`${t.channel}:${code}`);
      console.warn(`${LOG} заявка ${r.lead_id}: ${t.channel} не принял (${code})`);
    }

    // 3. ИИ-агент с живой подпиской — внеочередная сверка тем же захватом, что у крона.
    const agents = (await q(NOTICE_AGENT_KEYS_SQL, [r.lead_id])).rows as Array<{ key_id: string; last_error: string | null }>;
    if (agents.length > 0) {
      await (deps.notifyRun ?? defaultNotifyRun)(agents.map((a) => a.key_id));
      const after = await readRow(q, noticeId);
      if (after && after.state !== 'pending') return outcomeOfRow(after);
      const errs = (await q(NOTICE_AGENT_KEYS_SQL, [r.lead_id])).rows as Array<{ last_error: string | null }>;
      tried.push(`agent:${agentCode(errs.find((e) => e.last_error)?.last_error)}`);
    }

    // 4. Не дошло — менеджеру сразу. Если за это время статус прочитали — строки нет, и письма тоже.
    const und = await q(NOTICE_UNDELIVERED_SQL, [r.id, tried.join(',') || null]);
    if ((und.rowCount ?? 0) === 0) {
      const now = await readRow(q, noticeId);
      return now ? outcomeOfRow(now) : { state: 'pending' };
    }
    const manager = await alertManager(q, r, f, tried, shownDates, deps);
    return { state: 'undelivered', manager, hadChat: targets.length > 0 };
  } catch (err) {
    console.error(`${LOG} заявка ${leadId}: сообщение не отправлено — повторит добивка, SQLSTATE`, codeOf(err));
    return { state: 'pending' };
  }
}

/** Исход сообщения по ответу этого партнёра на эту дату заявки — повторное нажатие оператора. */
export const NOTICE_BY_ANSWER_SQL = `
  SELECT n.state, n.skipped_reason, n.delivered_via, n.tried, n.manager_channel
    FROM answer_notices n
    JOIN partner_incoming_answers pa ON pa.id = n.answer_id
   WHERE pa.subject_kind = 'lead' AND pa.subject_id = $1::text AND pa.partner_id = $2::uuid
     AND pa.subject_date IS NOT DISTINCT FROM $3::text`;

/** null — сообщения по такому ответу нет (ответ не из тех, о которых сообщаем) или не прочиталось. */
export async function readNoticeOutcomeFor(
  leadId: string, partnerId: string, date: string | null, deps: NoticeDeps = {},
): Promise<NoticeOutcome | null> {
  const q: Query = deps.query ?? ((sql, params) => pool.query(sql, params));
  try {
    const { rows: [row] } = await q(NOTICE_BY_ANSWER_SQL, [leadId, partnerId, date]);
    return row ? outcomeOfRow(row as NoticeRow) : null;
  } catch (err) {
    console.error(`${LOG} заявка ${leadId}: исход сообщения не прочитан, SQLSTATE`, codeOf(err));
    return null;
  }
}

export interface NoticeRunResult {
  status: 'ok' | 'db_error';
  picked: number;
  delivered: number;
  undelivered: number;
  skipped: number;
  manager_retried: number;
  manager_cleared: number;
  time_budget: number;
}

/** Добивка. Повторного сообщения человеку по таймеру нет — только обрыв и менеджер. */
export async function runAnswerNotices(deps: NoticeDeps = {}): Promise<NoticeRunResult> {
  const q: Query = deps.query ?? ((sql, params) => pool.query(sql, params));
  const now = deps.now ?? Date.now;
  const started = now();
  const res: NoticeRunResult = { status: 'ok', picked: 0, delivered: 0, undelivered: 0, skipped: 0, manager_retried: 0, manager_cleared: 0, time_budget: 0 };
  let due: Array<{ id: string; state: NoticeRow['state']; attempts: number }>;
  try {
    due = (await q(NOTICE_CLAIM_DUE_SQL)).rows as typeof due;
  } catch (err) {
    console.error(`${LOG} добивка: захват не удался, SQLSTATE`, codeOf(err));
    return { ...res, status: 'db_error' };
  }
  res.picked = due.length;
  for (const d of due) {
    if (now() - started >= NOTICE_RUN_TIME_BUDGET_MS) { res.time_budget++; continue; }
    try {
      if (d.state === 'pending' && Number(d.attempts) < NOTICE_MAX_TRIES) {
        const o = await deliverAnswerNotice(d.id, deps);
        if (o.state === 'delivered') res.delivered++;
        else if (o.state === 'undelivered') res.undelivered++;
        else if (o.state === 'skipped') res.skipped++;
        continue;
      }
      const r = await readRow(q, d.id);
      if (!r) continue;
      const { rows: [st] } = await q(REQUEST_STATUS_BY_LEAD_SQL, [r.lead_id]);
      const f = factsOf(r, st as StatusRow | undefined);
      if (r.state === 'pending') {
        // Падала уже не раз — человеку больше не шлём, менеджеру сразу.
        const tried = [...(r.tried ? r.tried.split(',') : []), 'retry_exhausted'];
        const und = await q(NOTICE_UNDELIVERED_SQL, [r.id, tried.join(',')]);
        if ((und.rowCount ?? 0) > 0) {
          res.undelivered++;
          await alertManager(q, r, f, tried, [], deps);
        }
      } else if (r.state === 'undelivered') {
        res.manager_retried++;
        await alertManager(q, r, f, r.tried ? r.tried.split(',') : [], [], deps);
      } else if (r.state === 'delivered' && r.manager_alerted && !r.manager_cleared) {
        const text = managerClearedText(r.lead_id, outcomeOfRow(r) as NoticeOutcome & { state: 'delivered' });
        const sent = await (deps.pdAlert ?? defaultPdAlert)({ text, stub: text });
        if (sent.channel !== 'none') {
          await q(NOTICE_CLEARED_SQL, [r.id]);
          res.manager_cleared++;
        }
      }
    } catch (err) {
      res.status = 'db_error';
      console.error(`${LOG} добивка: строка ${d.id} не обработана, SQLSTATE`, codeOf(err));
    }
  }
  return res;
}
