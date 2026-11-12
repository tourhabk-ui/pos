/**
 * lib/requests/answer-notice.ts — сообщение человеку после ответа
 * туроператора кнопкой (план «после отказа», этап 2б-1; слово владельца 11.11:
 * «карт-бланш по плану действуй», «мы доверяем агенту»).
 *
 * До этой правки «Нет мест», «Отказать» и «Другая дата» туристу не уходили
 * никак — ответ видел только тот, кто сам открыл статус. Теперь сразу в
 * нажатии оператора:
 *  1. вид заявки по-прежнему построен из этого ответа (shownAnswerRef) —
 *     иначе сообщать не о чем: бронь, новая дата, ответ перерос статус;
 *  2. чаты человека — те, что вправе нажимать даты этой заявки: связь чата с
 *     ключом НОВОЙ заявки (`opens_chat`), `guest_max_chat_id`, Telegram старых
 *     потоков бота; первое принятое сообщение — доставка, больше одного
 *     сообщения на ответ не уходит;
 *  3. никто из чатов не принял, а у ключа новой заявки живая подписка ИИ-агента
 *     — внеочередная сверка этой подписки тем же захватом, что у крона; что с
 *     ней вышло, говорит итог сверки, а не догадка: «не принял» — только когда
 *     его приёмник ответил отказом;
 *  4. иначе — «не доставлено», и менеджеру Ведара сразу, без таймеров: имя и
 *     телефон только в MAX (sendPdAlert), заглушка без ПД.
 * Прочтение статуса агентом или страницей на виду — тоже доставка
 * (answer-notice-mark); если оно пришло после письма менеджеру, добивка
 * пишет ему «звонить не нужно».
 *
 * Доставка «хотя бы раз», не «ровно один»: захват на 5 минут ставится при
 * вставке, у каждой ноги свой срок (чат 20 с, агент 25 с, письмо менеджеру
 * 30 с); упади процесс между отправкой и записью исхода — добивка отправит ещё
 * раз.
 *
 * Добивка тратит попытку строки, только когда её РАЗОБРАЛА: отложенная по
 * сроку прогона строка отпускается без потери попытки (ревью 2б), а новая
 * строка не начинается, если не успеет до конца шага (NOTICE_ROW_WORST_MS).
 * Письмо менеджеру из добивки уходит, только пока вид заявки — из этого
 * ответа: бронь или новая дата делают звонок с прежним отказом неправдой.
 *
 * Машина целиком и прокат (этап 2б-2, слово владельца 12.11 «1 да»): «Не
 * могу» перевозчика или прокатчика — та же строка и та же отправка, только
 * ответ лежит в журнале заявки (`activity_id`, 1425), а не в кнопке
 * туроператора. Дат рядом у них нет. Направление заявки на машину — свободный
 * ввод заказчика (адрес, имя): в Telegram (чат заказчика, заглушка менеджеру)
 * оно не уходит вовсе; название машины проката — из прайса прокатчика.
 *
 * Другие компании (этап 4а): после «Нет мест» и отказа не по погоде в то же
 * сообщение встаёт список компаний с турами к тому же месту, которые могут
 * принять на дату заявки (lib/requests/other-offers). Чтение — одним сроком с
 * проверкой дат после отказа по погоде: в одной строке они не встречаются
 * (после отказа по погоде других компаний не называем), и худший срок строки
 * не растёт. Не прочиталось или не уложилось — блока в сообщении нет, само
 * сообщение уходит.
 *
 * Логи — номер заявки, канал и код. Ни id чатов, ни текста ошибок MAX (там
 * может быть id), ни имени и телефона.
 */
import { pool } from '@/lib/db-pool';
import { getPublicBaseUrl } from '@/lib/config';
import { tourPath } from '@/lib/tours/tour-url';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { loadFreeDatesNear, type FreeDates } from '@/lib/tours/nearest-free-date';
import { checkTourDates, type DateCheck, type DateCheckDeps } from '@/lib/trips/date-check';
import { LEAD_ANSWER_DATE_SQL } from '@/lib/requests/answer-date';
import { DECLINE_REASONS, type DeclineReason } from '@/lib/requests/chat-answer-buttons';
import { MY_TRIP_DATE_ACTIONS_SQL, myTripDatePressable } from '@/lib/requests/my-trip-date';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { REQUEST_STATUS_BY_LEAD_SQL, groupPassedOnAnswer, shownAnswerRef, type ShownAnswerRef, type StatusRow } from '@/lib/mcp/request-status';
import { redactPII } from '@/lib/security/pii-redact';
import type { NotifyRunResult } from '@/lib/mcp/request-notify';
import {
  answerWantsDates, answerWantsOffers, isWeatherDecline, managerClearedText, managerUndeliveredText, personOf, touristAnswerText,
  undeliveredWhy,
  type DatesBlock, type ManagerChannel, type NoticeAnswer, type NoticeFacts, type NoticeKind, type NoticeOutcome, type OffersBlock,
  type WeatherDatesOutcome,
} from '@/lib/requests/answer-notice-text';
import { loadOtherOffers } from '@/lib/requests/other-offers';
import type { PdAlertParams, PdAlertResult } from '@/lib/notifications/pd-alert';
import { SELLER_CLOSED_ACTION } from '@/lib/leads/lost-reason';
import { managerQueueUrl } from '@/lib/manager-queue/link';

const LOG = '[answer-notice]';
/** Срок одной отправки в чат: больше сокетного срока MAX (15 с), чтобы дошедшее не записать «не дошло». */
export const NOTICE_SEND_TIMEOUT_MS = 20_000;
/** Больше стольких чатов у заявки на деле не бывает (созданный, гостевой MAX, Telegram); граница держит срок строки. */
export const NOTICE_CHAT_TARGETS_MAX = 3;
/** Внеочередная сверка подписки агента: её бюджет 12 с плюс попытка до 10 с. */
export const NOTICE_AGENT_TIMEOUT_MS = 25_000;
/** Письмо менеджеру: MAX до 15 с, затем заглушка в Telegram — у неё своего срока нет. */
export const NOTICE_MANAGER_TIMEOUT_MS = 30_000;
/**
 * Проверка дат после отказа по погоде (2в): прогноз, предупреждения, зона,
 * статус места. Не уложилась — даты считаются непроверенными и не называются.
 * Сам запрос прогноза ждёт источник до 12 с (lib/planner/intelligence): ответ,
 * пришедший между 10-й и 12-й секундой, здесь уже «не успел» — в сторону «дат
 * не называю». Поднять срок нельзя, не съев запас шага крона (см. ниже).
 */
export const NOTICE_CHECK_TIMEOUT_MS = 10_000;
/**
 * Чтение других компаний к месту на дату (4а): три запроса к базе. Срок — не
 * больше срока проверки дат: в одной строке они не встречаются, и
 * NOTICE_ROW_WORST_MS считает одно из двух.
 */
export const NOTICE_OFFERS_TIMEOUT_MS = 5_000;
/** Сколько свободных дат рядом проверять после отказа по погоде: часть отсеется. */
export const NOTICE_CHECK_CANDIDATES = 8;
/** На сколько дат с прежним отказом по погоде читать календарь шире — потолок, чтобы запрос не рос без меры. */
export const NOTICE_REFUSED_ROOM = 40;
/** Худший срок одной строки — все ноги по своему сроку плюс запросы к базе. */
export const NOTICE_ROW_WORST_MS = NOTICE_CHECK_TIMEOUT_MS + NOTICE_CHAT_TARGETS_MAX * NOTICE_SEND_TIMEOUT_MS
  + NOTICE_AGENT_TIMEOUT_MS + NOTICE_MANAGER_TIMEOUT_MS + 10_000;
/**
 * После стольких мс от начала прогона новая строка не начинается: она должна
 * кончиться до срока шага (`--max-time` в cron-safety-heartbeat.yml и
 * `timeoutMs` в start.js) — сторож: tests/unit/answer-notice.test.ts.
 */
export const NOTICE_RUN_START_BUDGET_MS = 40_000;
/** Сколько дат рядом показать. */
export const NOTICE_DATES = 4;
/** Сколько раз добивка шлёт человеку после обрыва (с нажатием — три попытки); дальше — менеджеру. */
export const NOTICE_MAX_TRIES = 3;
/** Больше стольких разборов добивка строку не берёт — её называет сторож (окно — сутки). */
export const NOTICE_MAX_ATTEMPTS = 12;
export const NOTICE_RUN_LIMIT = 20;

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
type Button = { text: string; payload: string };
type SendResult = { ok: true } | { ok: false; code: string };

export interface NoticeDeps {
  query?: Query;
  sendMax?: (chatId: string, text: string, buttons: Button[]) => Promise<SendResult>;
  sendTelegram?: (chatId: string, text: string, buttons: Button[]) => Promise<SendResult>;
  pdAlert?: (p: PdAlertParams) => Promise<PdAlertResult>;
  /** Внеочередная сверка подписок этих ключей (request-notify, onlyKeyIds). */
  notifyRun?: (keyIds: string[]) => Promise<NotifyRunResult>;
  freeDates?: typeof loadFreeDatesNear;
  /** Проверка дат после отказа по погоде или безопасности (lib/trips/date-check). */
  checkDates?: (tourId: number, declined: string, candidates: readonly string[], deps?: DateCheckDeps) => Promise<DateCheck>;
  /** Другие компании к тому же месту на дату заявки (lib/requests/other-offers). */
  otherOffers?: typeof loadOtherOffers;
  now?: () => number;
}

// ── SQL ──────────────────────────────────────────────────────────────────────

const TOUR_ID_SQL = `CASE WHEN l.source_data->>'tour_id' ~ '^[0-9]{1,18}$' THEN (l.source_data->>'tour_id')::bigint END`;

/**
 * Строка сообщения и факты заявки для слов — без имени и телефона. Ответ —
 * либо кнопка туроператора (`answer_id`), либо запись журнала (`activity_id`,
 * 1425). Запись журнала — двух родов (`activity_action`):
 *  - `partner_answered` — «Не могу» перевозчика или прокатчика: род, предмет и
 *    даты заявки — из деталей записи, как их видел партнёр в момент ответа.
 *    Ответивший — адресат заявки: чужую заявку ответ не записывает
 *    (loadOwnedRentalRequest), а другим партнёрам такие заявки не передаются;
 *  - `seller_closed` — продавец тура закрыл заявку «Отказ» с причиной в
 *    кабинете (этап 3а, lib/leads/owner-lead-status): заявка — на тур, слова —
 *    те же, что после кнопки «Отказать».
 */
export const NOTICE_FACTS_SQL = `
  SELECT n.id::text AS id, n.lead_id::text AS lead_id, n.answer_id::text AS answer_id, n.activity_id::text AS activity_id,
         n.answer, n.decline_reason,
         al.action AS activity_action,
         al.details->>'kind' AS vehicle_kind, al.details->>'car_title' AS vehicle_title,
         al.details->>'date_from' AS vehicle_from, al.details->>'date_to' AS vehicle_to,
         n.state, n.skipped_reason, n.delivered_via, n.tried, n.attempts, n.manager_channel,
         (n.manager_alerted_at IS NOT NULL) AS manager_alerted, (n.manager_cleared_at IS NOT NULL) AS manager_cleared,
         l.status AS lead_status,
         ${LEAD_ANSWER_DATE_SQL('l')} AS lead_date,
         CASE WHEN l.source_data->>'participants' ~ '^[0-9]{1,3}$' THEN (l.source_data->>'participants')::int END AS people,
         ${TOUR_ID_SQL} AS tour_id,
         ot.title AS tour_title, ot.slug AS tour_slug, COALESCE(${publicTourSql('ot')}, false) AS tour_public,
         p.name AS operator_name,
         (COALESCE(l.comment, '') LIKE '%[Поездка %') AS trip_part,
         ARRAY(SELECT pa_r.subject_date FROM partner_incoming_answers pa_r
                WHERE pa_r.subject_kind = 'lead' AND pa_r.subject_id = l.id::text
                  AND pa_r.partner_id = l.operator_id AND pa_r.answer = 'no_seats'
                  AND pa_r.subject_date IS NOT NULL) AS refused_dates,
         -- Даты, по которым на этом туре уже отказывали по погоде или безопасности
         -- (в любой заявке): тому, кто ведёт тур, виднее, чем прогнозу, — такую
         -- дату «проверенной» не называем (ревью 2в). Считается только для
         -- отказа по погоде: остальным строкам список не нужен. Приведение
         -- стоит на стороне лида (id::text): subject_id — текст любого рода
         -- предмета, и обратное приведение уронило бы запрос на не-uuid.
         CASE WHEN n.answer = 'decline' AND n.decline_reason = 'weather' THEN
           ARRAY(SELECT DISTINCT pa_w.subject_date FROM partner_incoming_answers pa_w
                   JOIN leads l_w ON l_w.id::text = pa_w.subject_id
                  WHERE pa_w.subject_kind = 'lead' AND pa_w.answer = 'decline' AND pa_w.decline_reason = 'weather'
                    AND pa_w.subject_date IS NOT NULL
                    AND l_w.source_data->>'tour_id' = l.source_data->>'tour_id')
         END AS weather_refused_dates,
         ${MY_TRIP_DATE_ACTIONS_SQL} AS date_actions
    FROM answer_notices n
    JOIN leads l ON l.id = n.lead_id
    LEFT JOIN partner_incoming_answers pa ON pa.id = n.answer_id
    LEFT JOIN lead_activity_log al ON al.id = n.activity_id
    LEFT JOIN operator_tours ot ON ot.id = ${TOUR_ID_SQL}
    LEFT JOIN partners p ON p.id = COALESCE(pa.partner_id, l.operator_id)
   WHERE n.id = $1::bigint`;

/**
 * Чаты человека. Связь чата — только через ключ НОВОЙ заявки (`opens_chat`):
 * ключ повтора получает любой, кто знает чужой телефон, тур и дату. Плюс
 * `guest_max_chat_id` (туда уже уходят слова адресата) и Telegram старых
 * потоков бота. Пара (канал, чат) — один раз. `can_pick` — тот же признак,
 * что у «Изменить дату» (MY_TRIP_DATE_LEAD_SQL): чат вправе менять дату.
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
   ORDER BY min(rank), max(created_at) DESC NULLS LAST
   LIMIT ${NOTICE_CHAT_TARGETS_MAX}`;

/** Ключи новой заявки с живой подпиской ИИ-агента. */
export const NOTICE_AGENT_KEYS_SQL = `
  SELECT k.id::text AS key_id
    FROM agent_request_keys k
    JOIN agent_request_notify n ON n.key_id = k.id
   WHERE k.lead_id = $1::uuid AND k.expires_at > NOW() AND k.opens_chat AND n.disabled_at IS NULL`;

/** Имя и телефон — только для письма менеджеру в MAX. */
export const NOTICE_CONTACT_SQL = `SELECT name, phone FROM leads WHERE id = $1::uuid`;

export const NOTICE_DELIVERED_SQL = `
  UPDATE answer_notices
     SET state = 'delivered', delivered_via = $2::text, tried = $3::text, delivered_at = NOW(),
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

/**
 * Канал письма менеджеру. «Дошло» (`manager_alerted_at`) — только при канале,
 * куда письмо ушло: `none` повторит добивка, `not_needed` — письма не было и
 * не будет (заявка переросла ответ).
 */
export const NOTICE_MANAGER_SQL = `
  UPDATE answer_notices
     SET manager_channel = $2::text,
         manager_alerted_at = CASE WHEN $2::text IN ('max', 'telegram-stub') THEN NOW() ELSE manager_alerted_at END,
         claimed_until = NULL
   WHERE id = $1::bigint`;

export const NOTICE_CLEARED_SQL = `
  UPDATE answer_notices SET manager_cleared_at = NOW(), claimed_until = NULL
   WHERE id = $1::bigint AND state = 'delivered' AND manager_cleared_at IS NULL`;

/**
 * Добивка: обрыв посреди отправки (`pending` после захвата), недоставленное,
 * о котором менеджеру ничего не дошло, и дошедшее после письма менеджеру —
 * «звонить не нужно». Захват — тем же UPDATE, параллельный прогон строку не
 * возьмёт. Попытку захват не тратит: её считает NOTICE_ATTEMPT_SQL при разборе.
 */
export const NOTICE_CLAIM_DUE_SQL = `
  UPDATE answer_notices n SET claimed_until = NOW() + INTERVAL '5 minutes'
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
  RETURNING n.id::text AS id, n.state`;

/**
 * Попытка — когда строку начали разбирать, до отправки: строка, на которой
 * процесс падает, всё равно доберёт предел и уйдёт менеджеру.
 */
export const NOTICE_ATTEMPT_SQL = `
  UPDATE answer_notices SET attempts = attempts + 1 WHERE id = $1::bigint RETURNING attempts`;

/** Отложенное по сроку прогона — назад в очередь, без потраченной попытки. */
export const NOTICE_RELEASE_SQL = `UPDATE answer_notices SET claimed_until = NULL WHERE id = ANY($1::bigint[])`;

/**
 * Застрявшее (сторож Watchdog), за последние сутки — стоячая тревога хуже
 * отсутствующей (так же окно у checkFailedSeatRequests):
 *  - `count` — до человека не дошло, и менеджер не знает: «ждёт» дольше цикла
 *    добивки (захват истёк или снят), «не доставлено» без письма менеджеру;
 *  - `uncleared` — дошло после письма менеджеру, а «звонить не нужно» ему не ушло.
 * 35 минут — 30 минут цикла добивки плюс 5 минут захвата, а не срок для
 * человека: о недоставке менеджер узнаёт сразу в нажатии.
 */
export const NOTICE_STUCK_SQL = `
  SELECT COUNT(*) FILTER (WHERE s.kind = 'undelivered')::text AS count,
         string_agg(left(s.lead_id::text, 8), ',' ORDER BY s.created_at) FILTER (WHERE s.kind = 'undelivered') AS ids,
         COUNT(*) FILTER (WHERE s.kind = 'uncleared')::text AS uncleared,
         string_agg(left(s.lead_id::text, 8), ',' ORDER BY s.created_at) FILTER (WHERE s.kind = 'uncleared') AS uncleared_ids
    FROM (
      SELECT lead_id, created_at, CASE WHEN state = 'delivered' THEN 'uncleared' ELSE 'undelivered' END AS kind
        FROM answer_notices
       WHERE created_at > NOW() - INTERVAL '24 hours'
         AND ((state = 'pending' AND COALESCE(claimed_until, created_at) < NOW() - INTERVAL '35 minutes')
           OR (state = 'undelivered' AND (manager_channel IS NULL OR manager_channel = 'none')
               AND decided_at < NOW() - INTERVAL '35 minutes')
           OR (state = 'delivered' AND manager_alerted_at IS NOT NULL AND manager_cleared_at IS NULL
               AND delivered_at < NOW() - INTERVAL '35 minutes'))
    ) s`;

// ── Строка и исход ───────────────────────────────────────────────────────────

interface NoticeRow {
  id: string;
  lead_id: string;
  /** Кнопка туроператора; у машины и проката — null. */
  answer_id: string | null;
  /** Запись журнала: ответ перевозчика или прокатчика либо закрытие продавцом тура с причиной; у кнопки — null. */
  activity_id: string | null;
  /** Род записи журнала: `partner_answered` или `seller_closed`. */
  activity_action?: string | null;
  vehicle_kind: string | null;
  vehicle_title: string | null;
  vehicle_from: string | null;
  vehicle_to: string | null;
  answer: NoticeAnswer;
  decline_reason: string | null;
  state: 'pending' | 'delivered' | 'undelivered' | 'skipped';
  skipped_reason: 'lead_closed' | 'not_addressee' | 'self' | 'outgrown' | null;
  delivered_via: 'max' | 'telegram' | 'agent_webhook' | 'agent_read' | 'page_seen' | null;
  tried: string | null;
  attempts: number;
  manager_channel: ManagerChannel | null;
  manager_alerted: boolean;
  manager_cleared: boolean;
  lead_status: string | null;
  lead_date: string | null;
  people: number | null;
  tour_id: string | number | null;
  tour_title: string | null;
  tour_slug: string | null;
  tour_public: boolean;
  operator_name: string | null;
  trip_part: boolean;
  refused_dates: string[] | null;
  /** Даты этого тура, по которым уже отказывали «погода или безопасность» — в любой заявке. */
  weather_refused_dates?: string[] | null;
  date_actions: number | null;
}

function codeOf(err: unknown): string {
  const c = (err as { code?: unknown })?.code;
  return typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c) ? c : 'нет';
}

/**
 * Код отправки — из белого списка: он ляжет в `tried` (CHECK 1424) и в лог.
 * Свободный текст ошибки канала мог бы нести id чата — его сюда не пускаем.
 */
const CHAT_CODES = new Set(['no_token', 'bad_id', 'api_error', 'timeout', 'exception']);
function chatCode(v: string): string {
  return CHAT_CODES.has(v) ? v : 'api_error';
}

/** Код приёмника агента — форма notify-send (`http_503`, `redirect_301`, `dns_failed`…), без свободного текста. */
function agentCode(v: string): string {
  return /^[a-z][a-z0-9_]{0,39}$/.test(v) ? v : 'not_accepted';
}

/**
 * Что вышло у ноги ИИ-агента — по итогу внеочередной сверки, а не по
 * догадке. «Не принял» (код его приёмника) — только когда запрос до него
 * дошёл; остальное — уведомление не уходило, и это названо своим кодом
 * (AGENT_NOT_SENT_CODES): вид заявки для агента не изменился (большая группа
 * после «Нет мест» — «ждёт оператора» и до, и после), нет ключа шифрования,
 * строку держит плановая сверка, лимиты, повтор по графику (ревью 2б).
 */
export function agentLegCode(r: NotifyRunResult | null | undefined): string {
  if (!r || typeof r !== 'object') return 'exception';
  if (r.status === 'no_encryption') return 'no_encryption';
  const refused = Object.keys(r.receiver_failed ?? {}).find((c) => (r.receiver_failed[c] ?? 0) > 0);
  if (refused) return agentCode(refused);
  // Ушло, а отметка доставки не записалась (или не прочиталась сверка) — сбой нашей базы.
  if (r.status === 'db_error' || r.delivered > 0) return 'db_error';
  if (r.checked === 0 && r.missing_view > 0) return 'no_view';
  if (r.checked > 0 && r.changed === 0) return 'no_change';
  const d = r.deferred;
  if (d.claimed_elsewhere > 0) return 'claimed_elsewhere';
  if (d.run_budget + d.host_run_budget + d.host_day_budget + d.time_budget + d.host_failed > 0) return 'deferred';
  if (r.changed > 0 && r.due === 0) return 'retry_later';
  return 'exception';
}

/**
 * Исход по записанной строке — для повторного нажатия и после чужой записи.
 * `held` — строку «ждёт» ещё держит захват нажатия: отправка идёт сейчас.
 */
export function outcomeOfRow(
  r: Pick<NoticeRow, 'state' | 'skipped_reason' | 'delivered_via' | 'tried' | 'manager_channel'> & { held?: boolean | null },
): NoticeOutcome {
  switch (r.state) {
    case 'delivered':
      return { state: 'delivered', via: r.delivered_via ?? 'max', dates: [] };
    case 'undelivered':
      return {
        state: 'undelivered',
        manager: r.manager_channel ?? 'none',
        why: undeliveredWhy((r.tried ?? '').split(',').filter(Boolean)),
      };
    case 'skipped':
      return { state: 'skipped', reason: r.skipped_reason ?? 'outgrown' };
    default:
      return r.held === true ? { state: 'pending', sending: true } : { state: 'pending' };
  }
}

async function readRow(q: Query, id: string): Promise<NoticeRow | null> {
  const { rows: [row] } = await q(NOTICE_FACTS_SQL, [id]);
  return (row as NoticeRow | undefined) ?? null;
}

function isDeclineReason(v: unknown): v is DeclineReason {
  return typeof v === 'string' && (DECLINE_REASONS as readonly string[]).includes(v);
}

/** Строка рождена закрытием продавцом тура с причиной, а не ответом перевозчика или прокатчика. */
const isSellerClosed = (r: Pick<NoticeRow, 'activity_id' | 'activity_action'>): boolean =>
  !!r.activity_id && r.activity_action === SELLER_CLOSED_ACTION;

/** Род заявки строки: журнал ответа без `kind` — прокат (так писали до 30.10). */
function kindOf(r: Pick<NoticeRow, 'activity_id' | 'activity_action' | 'vehicle_kind'>): NoticeKind {
  if (!r.activity_id || isSellerClosed(r)) return 'tour';
  return r.vehicle_kind === 'charter' ? 'charter' : 'rental';
}

/** На какой ответ ссылается строка сообщения: кнопка туроператора либо запись журнала заявки и её род. */
export interface NoticeAnswerRef {
  answer_id: string | null;
  activity_id: string | null;
  activity_action?: string | null;
}

/** Ответ, на который ссылается строка, — в той же форме, что у вида заявки. */
function refOf(r: NoticeAnswerRef): ShownAnswerRef | null {
  if (r.activity_id) return { source: isSellerClosed(r) ? 'closed' : 'vehicle', id: r.activity_id };
  return r.answer_id ? { source: 'tour', id: r.answer_id } : null;
}

/**
 * Вид заявки по-прежнему построен из ответа этой строки. Этим же правилом
 * живёт очередь менеджера (lib/manager-queue, этап 3б): заявка переросла отказ
 * (бронь, новая дата, возврат в работу) — звонить с ним некому и незачем.
 */
export function viewHolds(status: StatusRow | undefined, r: NoticeAnswerRef): boolean {
  if (!status) return false;
  const shown = shownAnswerRef(status);
  const mine = refOf(r);
  return shown !== null && mine !== null && shown.source === mine.source && shown.id === mine.id;
}

/** Где смотреть других: витрина перевозчиков или проката. */
const OFFERS_PATH: Record<Exclude<NoticeKind, 'tour'>, string> = { charter: '/transfers', rental: '/car-rental' };

function factsOf(r: NoticeRow, st: StatusRow | undefined): NoticeFacts {
  const reason = isDeclineReason(r.decline_reason) ? r.decline_reason : null;
  const kind = kindOf(r);
  return {
    leadId: r.lead_id,
    kind,
    ...(kind === 'tour' ? {} : {
      vehicleTitle: r.vehicle_title, vehicleFrom: r.vehicle_from, vehicleTo: r.vehicle_to,
      offersUrl: `${getPublicBaseUrl()}${OFFERS_PATH[kind]}`,
    }),
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

/** Ближайшие к дате заявки, по возрастанию — не больше `limit`. */
function nearestDates(dates: readonly string[], around: string, limit: number): string[] {
  const at = Date.parse(`${around}T00:00:00Z`);
  const gap = (d: string) => Math.abs(Date.parse(`${d}T00:00:00Z`) - at);
  return [...dates].sort((a, b) => gap(a) - gap(b) || a.localeCompare(b)).slice(0, limit).sort();
}

/**
 * Свободные даты рядом с датой заявки — без текущей и без прежних «Нет мест».
 * После отказа «погода или безопасность» (2в) — только прошедшие проверку
 * обстановки и места; проверка не уложилась в срок или не смогла — все
 * свободные даты считаются непроверенными, и ни одна не называется. Даты с
 * прежним отказом по погоде на этом туре не проверяются вовсе: они названы
 * числом, а если других свободных рядом нет — так и сказано.
 */
async function datesOf(r: NoticeRow, f: NoticeFacts, deps: NoticeDeps): Promise<DatesBlock> {
  // У машины и проката календаря дат нет: заказчик называет их сам.
  if (personOf(f.kind) === 'client' || !answerWantsDates(f)) return { kind: 'skip' };
  const tourId = r.tour_id === null ? NaN : Number(r.tour_id);
  // Тура нет на витрине — других его дат не предлагаем: заявку на них не оставить.
  if (!Number.isFinite(tourId) || !r.tour_public || !r.lead_date) return { kind: 'skip' };
  const weather = isWeatherDecline(f);
  const exclude = [r.lead_date, ...(r.refused_dates ?? [])];
  const people = f.people ?? 1;
  // Даты с прежним отказом по погоде в календаре свободны — «в календаре дат нет» о них
  // сказать нельзя (ревью 2в): они отсеиваются после чтения календаря и называются числом.
  // Читается с запасом на них: иначе восемь ближайших отказанных заслонили бы девятую свободную.
  const today = kamchatkaToday((deps.now ?? Date.now)());
  const refusedBefore = new Set((weather ? r.weather_refused_dates ?? [] : []).filter((d) => d >= today));
  const limit = weather ? NOTICE_CHECK_CANDIDATES + Math.min(refusedBefore.size, NOTICE_REFUSED_ROOM) : NOTICE_DATES;
  const free: FreeDates = await (deps.freeDates ?? loadFreeDatesNear)(tourId, people, r.lead_date, exclude, limit);
  if (free.state === 'failed') return { kind: 'failed' };
  if (!free.hasCalendar) return { kind: 'no_calendar' };
  const dates = free.dates.map((d) => d.date);
  if (dates.length === 0) return { kind: 'none' };
  if (!weather) return { kind: 'dates', dates };

  const open = dates.filter((d) => !refusedBefore.has(d));
  const refused = dates.length - open.length;
  if (open.length === 0) return { kind: 'weather_refused', count: refused };
  const candidates = nearestDates(open, r.lead_date, NOTICE_CHECK_CANDIDATES);

  const run = await inTime((deps.checkDates ?? checkTourDates)(tourId, r.lead_date, candidates, { now: deps.now }), NOTICE_CHECK_TIMEOUT_MS);
  if (!run.ok) {
    // Срок вышел или проверка упала — ни одна дата не проверена, и ни одна не называется.
    console.warn(`${LOG} заявка ${r.lead_id}: проверка дат после отказа по погоде не кончилась (${run.why}) — дат не называю`);
    return { kind: 'checked', check: { state: 'unchecked', why: [run.why] }, dates: [], refused };
  }
  const check = run.value;
  // Называется только дата из календаря, которую проверка вернула «чисто», — и только когда
  // данные Ведара видят причину отказа.
  const offered = check.state === 'confirmed' ? check.clear.filter((d) => candidates.includes(d)) : [];
  return { kind: 'checked', check, dates: nearestDates(offered, r.lead_date, NOTICE_DATES), refused };
}

/**
 * Другие компании к главному месту тура, которые могут принять на дату заявки
 * (4а). Блока нет по смыслу ответа, у заявки без тура или даты и когда дата
 * уже прошла. Не прочиталось или не уложилось в срок — `failed`: сообщение
 * уходит без блока.
 */
async function offersOf(r: NoticeRow, f: NoticeFacts, deps: NoticeDeps): Promise<OffersBlock> {
  if (!answerWantsOffers(f)) return { kind: 'skip' };
  const tourId = r.tour_id === null ? NaN : Number(r.tour_id);
  if (!Number.isFinite(tourId) || !r.lead_date) return { kind: 'skip' };
  if (r.lead_date < kamchatkaToday((deps.now ?? Date.now)())) return { kind: 'skip' };
  const run = await inTime(
    (deps.otherOffers ?? loadOtherOffers)({ tourId, date: r.lead_date, people: f.people ?? 1 }, { now: new Date((deps.now ?? Date.now)()) }),
    NOTICE_OFFERS_TIMEOUT_MS,
  );
  if (!run.ok) {
    console.warn(`${LOG} заявка ${r.lead_id}: другие компании на дату не прочитались (${run.why}) — сообщение уходит без них`);
    return { kind: 'failed' };
  }
  const o = run.value;
  if (o.state === 'failed') return { kind: 'failed' };
  if (o.state === 'none') return { kind: 'none' };
  return { kind: 'offers', placeName: o.placeName, placeUrl: o.placeUrl, offers: o.offers, more: o.more };
}

// ── Отправка ─────────────────────────────────────────────────────────────────

/** Срок на ногу. Срок не отменяет начатое — оно доработает само, исход назовётся по записи. */
async function inTime<T>(p: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; why: 'timeout' | 'exception' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ ok: false; why: 'timeout' }>((resolve) => { timer = setTimeout(() => resolve({ ok: false, why: 'timeout' }), ms); });
  const done = p.then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const, why: 'exception' as const }),
  );
  try {
    return await Promise.race([done, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function sendInTime(p: Promise<SendResult>): Promise<SendResult> {
  const r = await inTime(p, NOTICE_SEND_TIMEOUT_MS);
  return r.ok ? r.value : { ok: false, code: r.why };
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

async function defaultNotifyRun(keyIds: string[]): Promise<NotifyRunResult> {
  const { runRequestNotify } = await import('@/lib/mcp/request-notify');
  return runRequestNotify({ onlyKeyIds: keyIds, timeBudgetMs: 12_000 });
}

/** Письмо менеджеру в срок: не уложилось — `none`, и добивка повторит (дубль лучше молчания). */
async function pdAlertInTime(p: PdAlertParams, deps: NoticeDeps): Promise<PdAlertResult | 'timeout' | 'exception'> {
  const r = await inTime((deps.pdAlert ?? defaultPdAlert)(p), NOTICE_MANAGER_TIMEOUT_MS);
  return r.ok ? r.value : r.why;
}

/**
 * Те же факты для Telegram (критика 11.11, п. 7; ревью 2б-2, п. 5).
 * Направление заявки на машину — свободный ввод заказчика: телефон и почту
 * из него вырезать можно, адрес и имя — нет, поэтому туда оно не уходит
 * вовсе, а текст говорит «в заявке». Название машины проката — из прайса
 * прокатчика; чистка на нём — страховка, не правило.
 */
export function telegramSafeFacts(f: NoticeFacts): NoticeFacts {
  if (!f.vehicleTitle) return f;
  return f.kind === 'charter'
    ? { ...f, vehicleTitle: null, vehicleTitleHidden: true }
    : { ...f, vehicleTitle: redactPII(f.vehicleTitle) };
}

/** Менеджеру: до человека не дошло. Канал письма — в строку; «дошло» — только при канале. */
async function alertManager(
  q: Query, r: NoticeRow, f: NoticeFacts, tried: string[], dates: string[], offers: OffersBlock, deps: NoticeDeps,
): Promise<'max' | 'telegram-stub' | 'none'> {
  let channel: 'max' | 'telegram-stub' | 'none' = 'none';
  try {
    const { rows: [c] } = await q(NOTICE_CONTACT_SQL, [r.lead_id]);
    const contact = (c ?? {}) as { name?: string | null; phone?: string | null };
    // Другие компании на дату — тому, кто будет звонить: человеку список не дошёл.
    const msg = managerUndeliveredText(f, { name: contact.name ?? null, phone: contact.phone ?? null }, tried, dates, offers);
    const res = await pdAlertInTime({
      text: msg.text,
      // Заглушка уходит в Telegram: слова заказчика — только после чистки.
      stub: managerUndeliveredText(telegramSafeFacts(f), { name: null, phone: null }, tried, dates).stub,
      // Недоставленный отказ стоит в очереди менеджера (этап 3б): там же отметка «Взял».
      buttons: [
        { text: 'Очередь менеджера', url: managerQueueUrl() },
        { text: 'Заявки в админке', url: `${getPublicBaseUrl()}/hub/admin/leads` },
      ],
    }, deps);
    if (typeof res === 'string') {
      console.error(`${LOG} заявка ${r.lead_id}: письмо менеджеру — ${res}, повторит добивка`);
    } else {
      channel = res.channel === 'max' && res.delivered ? 'max' : res.channel === 'telegram-stub' ? 'telegram-stub' : 'none';
      if (channel === 'none') console.error(`${LOG} заявка ${r.lead_id}: менеджеру не дошло (${res.channel}) — повторит добивка`);
    }
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
    if (!viewHolds(status, r)) {
      await q(NOTICE_SKIPPED_SQL, [r.id, 'outgrown']);
      return outcomeOfRow((await readRow(q, noticeId)) ?? { ...r, state: 'skipped', skipped_reason: 'outgrown' });
    }
    const f = factsOf(r, status);
    const dates = await datesOf(r, f, deps);
    const offers = await offersOf(r, f, deps);
    const shownDates = dates.kind === 'dates' || dates.kind === 'checked' ? dates.dates : [];
    // Чем кончился блок дат после отказа по погоде — оператору: что сказано туристу.
    const check: WeatherDatesOutcome | undefined = dates.kind === 'checked' ? dates.check.state
      : dates.kind === 'weather_refused' ? 'weather_refused' : undefined;
    // Кнопки дат — только если нажатие пройдёт: поездка впереди, лимит смен не
    // исчерпан (то же правило, что у «Изменить дату»). Брони нет: иначе вид
    // заявки был бы не из этого ответа (шаг 1).
    const pressable = myTripDatePressable({
      status: r.lead_status, booking_status: null, booking_date: null,
      date: r.lead_date, tour_id: r.tour_id, date_actions: Number(r.date_actions ?? 0),
    }, kamchatkaToday((deps.now ?? Date.now)()));

    // 2. Чаты человека — первое принятое сообщение и есть доставка.
    const tried: string[] = [];
    const targets = (await q(NOTICE_TARGETS_SQL, [r.lead_id])).rows as Array<{ channel: 'max' | 'telegram'; chat_id: string; can_pick: boolean }>;
    for (const t of targets) {
      const msg = touristAnswerText(t.channel === 'telegram' ? telegramSafeFacts(f) : f, dates, t.can_pick === true && !r.trip_part && pressable, offers);
      const send = t.channel === 'max' ? (deps.sendMax ?? defaultSendMax) : (deps.sendTelegram ?? defaultSendTelegram);
      const res = await sendInTime(send(String(t.chat_id), msg.text, msg.buttons));
      if (res.ok) {
        await q(NOTICE_DELIVERED_SQL, [r.id, t.channel, tried.join(',') || null]);
        console.info(`${LOG} заявка ${r.lead_id}: доставлено (${t.channel})`);
        // Сколько компаний названо — по тексту, который ушёл: строки, не вошедшие в предел, не в счёт.
        return { state: 'delivered', via: t.channel, dates: shownDates, ...(check ? { check } : {}), ...(msg.offers > 0 ? { offers: msg.offers } : {}) };
      }
      const code = res.ok ? 'api_error' : chatCode(res.code);
      tried.push(`${t.channel}:${code}`);
      console.warn(`${LOG} заявка ${r.lead_id}: ${t.channel} не принял (${code})`);
    }

    // 3. ИИ-агент с живой подпиской — внеочередная сверка тем же захватом, что у крона.
    const agents = (await q(NOTICE_AGENT_KEYS_SQL, [r.lead_id])).rows as Array<{ key_id: string }>;
    if (agents.length > 0) {
      const run = await inTime((deps.notifyRun ?? defaultNotifyRun)(agents.map((a) => a.key_id)), NOTICE_AGENT_TIMEOUT_MS);
      const after = await readRow(q, noticeId);
      if (after && after.state !== 'pending') return outcomeOfRow(after);
      const code = run.ok ? agentLegCode(run.value) : run.why === 'timeout' ? 'slow' : 'exception';
      tried.push(`agent:${code}`);
      console.warn(`${LOG} заявка ${r.lead_id}: ИИ-агенту не доставлено (${code})`);
    }

    // 4. Не дошло — менеджеру сразу. Если за это время статус прочитали — строки нет, и письма тоже.
    const und = await q(NOTICE_UNDELIVERED_SQL, [r.id, tried.join(',') || null]);
    if ((und.rowCount ?? 0) === 0) {
      const now = await readRow(q, noticeId);
      return now ? outcomeOfRow(now) : { state: 'pending' };
    }
    const manager = await alertManager(q, r, f, tried, shownDates, offers, deps);
    return { state: 'undelivered', manager, why: undeliveredWhy(tried) };
  } catch (err) {
    console.error(`${LOG} заявка ${leadId}: сообщение не отправлено — повторит добивка, SQLSTATE`, codeOf(err));
    return { state: 'pending' };
  }
}

/** Исход сообщения по ответу этого партнёра на эту дату заявки — повторное нажатие оператора. */
export const NOTICE_BY_ANSWER_SQL = `
  SELECT n.state, n.skipped_reason, n.delivered_via, n.tried, n.manager_channel,
         (n.claimed_until > NOW()) AS held
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

/** Исход сообщения по ответу перевозчика или прокатчика: ответ на заявку один (индекс 1326). */
export const NOTICE_BY_VEHICLE_LEAD_SQL = `
  SELECT n.state, n.skipped_reason, n.delivered_via, n.tried, n.manager_channel,
         (n.claimed_until > NOW()) AS held
    FROM answer_notices n
   WHERE n.lead_id = $1::uuid AND n.activity_id IS NOT NULL
   ORDER BY n.id DESC
   LIMIT 1`;

/** null — сообщения по этой заявке нет («Беру» или ответ до 1425) или не прочиталось. */
export async function readVehicleNoticeOutcome(leadId: string, deps: NoticeDeps = {}): Promise<NoticeOutcome | null> {
  const q: Query = deps.query ?? ((sql, params) => pool.query(sql, params));
  try {
    const { rows: [row] } = await q(NOTICE_BY_VEHICLE_LEAD_SQL, [leadId]);
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
  /** Письмо менеджеру ждало повтора, а заявка переросла ответ — не послано. */
  manager_not_needed: number;
  /** Отложено по сроку прогона и отпущено без потраченной попытки. */
  time_budget: number;
}

/** Добивка. Повторного сообщения человеку по таймеру нет — только обрыв и менеджер. */
export async function runAnswerNotices(deps: NoticeDeps = {}): Promise<NoticeRunResult> {
  const q: Query = deps.query ?? ((sql, params) => pool.query(sql, params));
  const now = deps.now ?? Date.now;
  const started = now();
  const res: NoticeRunResult = {
    status: 'ok', picked: 0, delivered: 0, undelivered: 0, skipped: 0,
    manager_retried: 0, manager_cleared: 0, manager_not_needed: 0, time_budget: 0,
  };
  let due: Array<{ id: string; state: NoticeRow['state'] }>;
  try {
    due = (await q(NOTICE_CLAIM_DUE_SQL)).rows as typeof due;
  } catch (err) {
    console.error(`${LOG} добивка: захват не удался, SQLSTATE`, codeOf(err));
    return { ...res, status: 'db_error' };
  }
  res.picked = due.length;
  const release: string[] = [];
  for (const d of due) {
    // Новую строку — только если она успеет до срока шага: худший срок строки известен.
    if (now() - started >= NOTICE_RUN_START_BUDGET_MS) { res.time_budget++; release.push(d.id); continue; }
    try {
      const { rows: [a] } = await q(NOTICE_ATTEMPT_SQL, [d.id]);
      if (!a) continue;
      const attempts = Number((a as { attempts: number }).attempts);
      if (d.state === 'pending' && attempts < NOTICE_MAX_TRIES) {
        const o = await deliverAnswerNotice(d.id, deps);
        if (o.state === 'delivered') res.delivered++;
        else if (o.state === 'undelivered') res.undelivered++;
        else if (o.state === 'skipped') res.skipped++;
        continue;
      }
      const r = await readRow(q, d.id);
      if (!r) continue;
      if (r.state === 'delivered') {
        if (!r.manager_alerted || r.manager_cleared) continue;
        const text = managerClearedText(r.lead_id, outcomeOfRow(r) as NoticeOutcome & { state: 'delivered' }, kindOf(r));
        const sent = await pdAlertInTime({ text, stub: text }, deps);
        if (typeof sent !== 'string' && sent.channel !== 'none') {
          await q(NOTICE_CLEARED_SQL, [r.id]);
          res.manager_cleared++;
        }
        continue;
      }
      // Письмо менеджеру — только пока вид заявки из этого ответа: после брони
      // или новой даты звонок с прежним отказом был бы неправдой.
      const { rows: [st] } = await q(REQUEST_STATUS_BY_LEAD_SQL, [r.lead_id]);
      const status = st as StatusRow | undefined;
      const holds = viewHolds(status, r);
      const f = factsOf(r, status);
      if (r.state === 'pending') {
        if (!holds) {
          await q(NOTICE_SKIPPED_SQL, [r.id, 'outgrown']);
          res.skipped++;
          continue;
        }
        // Обрывалась не раз — человеку больше не шлём, менеджеру сразу.
        const tried = [...(r.tried ? r.tried.split(',') : []), 'retry_exhausted'];
        const und = await q(NOTICE_UNDELIVERED_SQL, [r.id, tried.join(',')]);
        if ((und.rowCount ?? 0) > 0) {
          res.undelivered++;
          // Повтор и письмо после исчерпанных попыток — без дат и без других компаний: их здесь не читали.
          await alertManager(q, r, f, tried, [], { kind: 'skip' }, deps);
        }
      } else if (r.state === 'undelivered') {
        if (!holds) {
          await q(NOTICE_MANAGER_SQL, [r.id, 'not_needed']);
          res.manager_not_needed++;
          continue;
        }
        res.manager_retried++;
        await alertManager(q, r, f, r.tried ? r.tried.split(',') : [], [], { kind: 'skip' }, deps);
      }
    } catch (err) {
      res.status = 'db_error';
      console.error(`${LOG} добивка: строка ${d.id} не обработана, SQLSTATE`, codeOf(err));
    }
  }
  if (release.length > 0) {
    try {
      await q(NOTICE_RELEASE_SQL, [release]);
    } catch (err) {
      // Не отпустили — захват истечёт сам через 5 минут; попытка всё равно не потрачена.
      res.status = 'db_error';
      console.error(`${LOG} добивка: отложенные не отпущены, SQLSTATE`, codeOf(err));
    }
  }
  return res;
}
