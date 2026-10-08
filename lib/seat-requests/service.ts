/**
 * Запрос свободных мест у оператора — работа с базой и каналами.
 *
 * Поток (решения владельца 29.09):
 *   1. турист из планера спрашивает тур, дату и число людей (createSeatRequest);
 *   2. оператору уходит сообщение С КНОПКАМИ «Есть места» / «Мест нет» и
 *      ссылкой «Другая дата». В нём НЕТ имени и телефона туриста: чтобы
 *      ответить про места, они не нужны, а сообщение идёт и в Telegram, куда
 *      ПД не уходят по решению владельца 23.08. Контакты придут ПОСЛЕ ответа
 *      «есть» — обычным уведомлением о брони;
 *   3. «Есть места» СРАЗУ заводит бронь той же дверью, что сайт и Кузьмич
 *      (reserveBooking), подтверждает её (confirmBooking) и уведомляет
 *      оператора тем же хвостом, что веб-форма (notifyOperatorOfNewBooking);
 *   4. 2 часа без ответа — 'expired', «оператор не ответил» (не «мест нет»);
 *   5. исход уходит туристу в его мессенджер, если он подключил чат, и всегда
 *      виден на странице статуса.
 *
 * Надёжность. Ответ захватывается атомарно (UPDATE ... WHERE answered_at IS
 * NULL), а бронь, подтверждение и запись исхода идут отдельными транзакциями:
 * общий клиент с reserveBooking не разделить. Процесс может оборваться между
 * ними — деплой Timeweb идёт по каждому push. Поэтому у «принят, но не
 * доведён» есть уборщик (recoverUnfinished): такой запрос не висит вечно
 * «ждём ответа», а превращается в 'failed' или 'confirmed' по факту в базе.
 *
 * Отказы не глушатся (§4.0): каждый выход в «не смог» пишет причину в лог и
 * возвращает её вызывающему.
 */

import { pool } from '@/lib/db-pool';
import { keepsScheduleSql } from '@/lib/tours/schedule';
import { getPublicBaseUrl } from '@/lib/config';
import { reachForPartner } from '@/lib/partners/reach';
import { sendPdAlert } from '@/lib/notifications/pd-alert';
import { telegramService } from '@/lib/notifications/telegram';
import { maxSendDm } from '@/lib/notifications/max-channel';
import { reserveBooking, ReserveError } from '@/lib/bookings/reserve';
import { loadPriceTiers } from '@/lib/tours/honest-price';
import { pickPriceTier } from '@/lib/tours/price-tiers';
import { confirmBooking } from '@/lib/bookings/booking.service';
import { notifyOperatorOfNewBooking } from '@/lib/bookings/notify-operator';
import { encrypt, decrypt } from '@/lib/encryption';
import { telegramBot, maxBot } from '@/lib/partners/channel-link';
import { normalizePhone } from '@/lib/mcp/normalize-phone';
import { escapeHtml } from '@/lib/text/escape-html';
import type { PdConsentRecord } from '@/lib/legal/pd-consent';
import {
  SEAT_REQUEST_DEADLINE_MS, answerPayload, effectiveStatus, hashStatusToken,
  isFutureOrToday, isRealDate, kamchatkaToday, newStatusToken, operatorAnswerKey, touristOutcomeText,
  TOURIST_START_PREFIX,
  type FailureKind, type OperatorAnswer, type ReplyChannel, type SeatRequestStatus,
  type TouristMessageState,
} from '@/lib/seat-requests/core';
import { platformAcceptsPayments } from '@/lib/payments/accepting';

// ── Потолки ───────────────────────────────────────────────────────────────
// Публичная запись без аккаунта: без потолков один скрипт заваливал бы
// оператора сообщениями с кнопками. Лимит по IP их не заменяет — IP подделать
// проще, чем телефон, и защита должна стоять там, где вред (у оператора).

/** Ждущих запросов у одного оператора. */
export const MAX_PENDING_PER_OPERATOR = 20;
/**
 * Из них — пришедших через публичный MCP (анонимный вход). Проверка MCP 29.09:
 * один неизменный клиент при лимите записи 5 за 10 минут за 40 минут занимал
 * все 20 мест оператора на 2 часа, и туристы с сайта получали «слишком много
 * запросов». Отдельный потолок оставляет сайту не меньше 15.
 */
export const MAX_PENDING_PER_OPERATOR_MCP = 5;
/** Ждущих запросов с одного телефона (на разные туры). */
export const MAX_PENDING_PER_PHONE = 3;
/** Запросов с одного телефона за сутки. */
export const MAX_PER_PHONE_PER_DAY = 10;
/** Сколько раз пытаемся сообщить исход туристу в мессенджер. */
export const MAX_TOURIST_NOTIFY_ATTEMPTS = 12;
/** Ответ принят, а исхода нет дольше этого — процесс оборвался. */
export const UNFINISHED_AFTER_MINUTES = 10;

function logFail(where: string, err: unknown): void {
  const e = err as { message?: string; code?: string };
  console.error(`[seat-requests] ${where}:`, e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
}

/**
 * Страница статуса. Ключ — во ФРАГМЕНТЕ (#), а не в пути: фрагмент не уходит
 * ни на сервер, ни в Referer, ни в page_views. Ключ в пути оседал бы в
 * собственной метрике открытым текстом (обзор 29.09).
 */
export function statusUrl(token: string): string {
  return `${getPublicBaseUrl()}/seat-request#${token}`;
}

/** «Старт» по этой ссылке — и ответ оператора придёт туристу в мессенджер. */
export function touristBotLinks(token: string): { telegram: string; max: string } {
  const start = `${TOURIST_START_PREFIX}${token}`;
  return { telegram: `https://t.me/${telegramBot()}?start=${start}`, max: `${maxBot()}?start=${start}` };
}

export function operatorAnswerUrl(requestId: string): string | null {
  const key = operatorAnswerKey(requestId);
  return key ? `${getPublicBaseUrl()}/seat-request/answer/${requestId}?k=${key}` : null;
}

// ── 1. Создание ───────────────────────────────────────────────────────────

export interface CreateSeatRequestInput {
  tourId: number;
  date: string;
  participants: number;
  touristName: string;
  touristPhone: string;
  replyChannel: ReplyChannel;
  pdConsent: PdConsentRecord;
  referralCode?: string | null;
  source?: string;
}

export type CreateSeatRequestFailure =
  | 'date_past' | 'bad_date' | 'bad_phone' | 'tour_not_found' | 'operator_unreachable'
  | 'duplicate' | 'already_confirmed' | 'too_many' | 'check_failed' | 'delivery_failed' | 'price_unknown';

// Ключ страницы статуса при отказе НЕ возвращается никогда: телефон — не
// секрет, и «дубль → ссылка на чужой запрос» отдавало бы страницу статуса, а с
// ней ссылку на бронь, любому, кто знает номер (обзор 29.09). Автор возвращается
// к своему запросу по ссылке, полученной при отправке.
export type CreateSeatRequestResult =
  | { ok: true; requestId: string; statusToken: string; deadlineAt: Date; operatorDelivery: 'max' | 'telegram-stub' }
  | { ok: false; reason: CreateSeatRequestFailure };

/**
 * Ведёт ли тур расписание: есть ли хоть одна будущая (по Камчатке) неотменённая
 * дата в `tour_availability`. Три исхода (§4.0): true / false / null — «не
 * смог проверить». Отличает «мест нет» (расписание есть, места разобраны) от
 * «расписания нет» (оператор берёт туристов без календаря): во втором случае
 * честный ответ — спросить оператора, а не отказать.
 */
export async function tourKeepsSchedule(tourId: number): Promise<boolean | null> {
  try {
    const { rows } = await pool.query<{ has: boolean }>(
      `SELECT ${keepsScheduleSql('$1')} AS has`,
      [tourId],
    );
    return rows[0]?.has === true;
  } catch (err) { logFail('расписание тура не прочитано', err); return null; }
}

export async function createSeatRequest(input: CreateSeatRequestInput): Promise<CreateSeatRequestResult> {
  // Несуществующая дата (2099-02-31) — не «прошедшая»: это разные слова.
  if (!isRealDate(input.date)) return { ok: false, reason: 'bad_date' };
  if (!isFutureOrToday(input.date)) return { ok: false, reason: 'date_past' };
  // Десять цифр без кода страны («900 123-45-67») — российский номер: общий
  // normalizePhone дал бы из них «+9001234567», по которому оператору нечем
  // позвонить, а «+7 900…» того же человека обходил бы дубль и потолки.
  const rawDigits = input.touristPhone.replace(/\D/g, '');
  const phone = normalizePhone(
    !input.touristPhone.trim().startsWith('+') && rawDigits.length === 10 ? `7${rawDigits}` : input.touristPhone,
  );
  if (phone === null) return { ok: false, reason: 'bad_phone' };

  let tour: { operator_id: string; title: string; price_unit: string | null } | undefined;
  try {
    ({ rows: [tour] } = await pool.query<{ operator_id: string; title: string; price_unit: string | null }>(
      `SELECT operator_id, title, price_unit FROM operator_tours
        WHERE id = $1 AND is_active = true AND is_published = true AND deleted_at IS NULL`,
      [input.tourId],
    ));
  } catch (err) { logFail('тур не прочитан', err); return { ok: false, reason: 'check_failed' }; }
  if (!tour) return { ok: false, reason: 'tour_not_found' };

  // Цена по размеру группы (#2246): если ступени есть, а группа в них не
  // входит, запрос до оператора не доходит. Иначе он ответил бы «есть места», а
  // бронь после его ответа не завелась бы — суммы для такой группы нет, и
  // турист увидел бы «учёт платформы» вместо внятного отказа. Не удалось
  // прочитать ступени — это «не смог проверить», а не «ступеней нет».
  try {
    const tiers = await loadPriceTiers(input.tourId);
    if (pickPriceTier(tiers, input.participants, tour.price_unit).kind === 'miss') {
      return { ok: false, reason: 'price_unknown' };
    }
  } catch (err) { logFail('ступени цены не прочитаны', err); return { ok: false, reason: 'check_failed' }; }

  // Оператору некуда написать — запрос не заводится вовсе. Иначе турист
  // ждал бы два часа ответа, которого не может быть, и получил бы «оператор
  // не ответил» — ложь о человеке, которому никто не писал.
  const reach = await reachForPartner(tour.operator_id);
  if (reach === null) return { ok: false, reason: 'check_failed' };
  if (!reach.reachable) return { ok: false, reason: 'operator_unreachable' };

  // Дубли и потолки — до вставки и до сообщения оператору.
  try {
    // Просроченный, но ещё не убранный ждущий запрос закрывается ЗДЕСЬ:
    // уникальный индекс держит любую строку 'pending' независимо от срока, а
    // уборщик приходит раз в полчаса. Без этого турист, которому страница уже
    // сказала «отправьте ещё раз», получал бы ложное «уже отправлен».
    await pool.query(
      `UPDATE tour_seat_requests
          SET status = 'expired', updated_at = NOW()
        WHERE tour_id = $1 AND tour_date = $2::date AND tourist_phone = $3
          AND status = 'pending' AND answered_at IS NULL AND deadline_at <= NOW()`,
      [input.tourId, input.date, phone],
    );

    const { rows: [dup] } = await pool.query<{ status: SeatRequestStatus }>(
      `SELECT r.status
         FROM tour_seat_requests r
         LEFT JOIN operator_bookings b ON b.id = r.booking_id
        WHERE r.tour_id = $1 AND r.tour_date = $2::date AND r.tourist_phone = $3
          AND ((r.status = 'pending' AND r.deadline_at > NOW())
               OR (r.status = 'confirmed'
                   AND b.booking_status NOT IN ('cancelled', 'rejected') AND b.deleted_at IS NULL))
        LIMIT 1`,
      [input.tourId, input.date, phone],
    );
    if (dup) {
      return { ok: false, reason: dup.status === 'confirmed' ? 'already_confirmed' : 'duplicate' };
    }

    const { rows: [caps] } = await pool.query<{ op_pending: number; op_pending_mcp: number; phone_pending: number; phone_day: number }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'pending' AND deadline_at > NOW() AND operator_id = $1)::int AS op_pending,
              COUNT(*) FILTER (WHERE status = 'pending' AND deadline_at > NOW() AND operator_id = $1
                                 AND source = 'mcp')::int AS op_pending_mcp,
              COUNT(*) FILTER (WHERE status = 'pending' AND deadline_at > NOW() AND tourist_phone = $2)::int AS phone_pending,
              COUNT(*) FILTER (WHERE tourist_phone = $2 AND created_at > NOW() - INTERVAL '24 hours')::int AS phone_day
         FROM tour_seat_requests
        WHERE operator_id = $1 OR tourist_phone = $2`,
      [tour.operator_id, phone],
    );
    if (
      (caps?.op_pending ?? 0) >= MAX_PENDING_PER_OPERATOR
      || (input.source === 'mcp' && (caps?.op_pending_mcp ?? 0) >= MAX_PENDING_PER_OPERATOR_MCP)
      || (caps?.phone_pending ?? 0) >= MAX_PENDING_PER_PHONE
      || (caps?.phone_day ?? 0) >= MAX_PER_PHONE_PER_DAY
    ) return { ok: false, reason: 'too_many' };
  } catch (err) { logFail('дубли и потолки не проверены', err); return { ok: false, reason: 'check_failed' }; }

  const { token, hash } = newStatusToken();
  const deadlineAt = new Date(Date.now() + SEAT_REQUEST_DEADLINE_MS);
  let requestId: string;
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tour_seat_requests
         (tour_id, operator_id, tour_date, participants, tourist_name, tourist_phone,
          reply_channel, status_token_hash, status_token_enc, deadline_at, source, referral_code,
          pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING id`,
      [input.tourId, tour.operator_id, input.date, input.participants, input.touristName,
       phone, input.replyChannel, hash, encrypt(token), deadlineAt, input.source ?? 'planner',
       input.referralCode ?? null,
       input.pdConsent.at, input.pdConsent.ip, input.pdConsent.source, input.pdConsent.version],
    );
    requestId = rows[0]!.id;
  } catch (err) {
    // Гонка двух одинаковых запросов: проверку выше прошли оба, вставку — один.
    if ((err as { code?: string }).code === '23505') return { ok: false, reason: 'duplicate' };
    logFail('запрос не записан', err);
    return { ok: false, reason: 'check_failed' };
  }

  const answerUrl = operatorAnswerUrl(requestId);
  const what = `«${escapeHtml(tour.title)}», ${input.date}, ${input.participants} чел.`;
  const deadlineLocal = deadlineAt.toLocaleTimeString('ru-RU', { timeZone: 'Asia/Kamchatka', hour: '2-digit', minute: '2-digit' });
  // Текст БЕЗ ПД: сообщение уходит и в MAX, и в Telegram-заглушку. Через дверь
  // pd-alert он идёт ради кнопок MAX и строгой доставки названному адресату.
  const text = [
    '<b>Запрос свободных мест</b>',
    what,
    '',
    `Ответьте до ${deadlineLocal} (по Камчатке). «Есть места» — бронь сразу заводится и подтверждается, ${platformAcceptsPayments() ? 'турист получает ссылку на оплату' : 'оплату турист вносит вам напрямую'}, а вам придёт обычное уведомление о брони с его контактами (в MAX или в кабинет; если у вас нет ни того ни другого — их передаст администратор).`,
  ].join('\n');
  const delivery = await sendPdAlert({
    text,
    stub: text,
    buttons: [
      { text: 'Есть места', payload: answerPayload('yes', requestId) },
      { text: 'Мест нет', payload: answerPayload('no', requestId) },
      ...(answerUrl ? [{ text: 'Другая дата / ответить на сайте', url: answerUrl }] : []),
    ],
    to: { maxChatId: reach.maxChatId, telegramChatId: reach.telegramChatId },
  });

  // Не дошло никуда — запрос закрывается сразу, туристу говорится правда
  // сейчас, а не через два часа.
  const failed = delivery.channel === 'none';
  try {
    await pool.query(
      `UPDATE tour_seat_requests
          SET operator_delivery = $2,
              status = CASE WHEN $3::boolean THEN 'failed' ELSE status END,
              failure_kind = CASE WHEN $3::boolean THEN 'delivery' ELSE failure_kind END,
              failure_reason = CASE WHEN $3::boolean THEN $4 ELSE failure_reason END,
              updated_at = NOW()
        WHERE id = $1`,
      [requestId, delivery.channel, failed, `запрос не доставлен оператору: ${delivery.reason}`],
    );
  } catch (err) { logFail('исход доставки оператору не записан', err); }

  if (failed) {
    console.error(`[seat-requests] запрос ${requestId} не доставлен оператору: ${delivery.reason}`);
    return { ok: false, reason: 'delivery_failed' };
  }
  return { ok: true, requestId, statusToken: token, deadlineAt, operatorDelivery: delivery.channel as 'max' | 'telegram-stub' };
}

// ── 2. Ответ оператора ────────────────────────────────────────────────────

export type AnswerResult =
  | {
      ok: true; status: SeatRequestStatus; tourTitle: string; date: string;
      failureKind: FailureKind | null; touristMessage: TouristMessageState;
      /**
       * Дошло ли оператору уведомление о брони с контактами туриста. null —
       * не применимо (бронь не заводилась). false — не дошло: оператору так и
       * говорится, контакты ему передаст администратор.
       */
      operatorNotified: boolean | null;
    }
  | {
      ok: false;
      reason: 'not_found' | 'already_answered' | 'expired' | 'date_past' | 'bad_date' | 'db_error' | 'accepted_unfinished';
      status?: SeatRequestStatus;
    };

interface ClaimedRow {
  id: string; tour_id: string; operator_id: string; tour_date: string; participants: number;
  tourist_name: string; tourist_phone: string; title: string; referral_code: string | null;
  pd_consent_at: Date; pd_consent_ip: string | null; pd_consent_source: string | null; pd_consent_version: string | null;
}

/**
 * Адресован ли запрос оператору, чей это MAX-чат. Право нажать кнопку —
 * принадлежность ЧАТА сообщения: user_id прислал бы кто угодно, а чат
 * сообщения с кнопкой подделать нельзя (тот же принцип, что у кнопок лидов).
 */
export async function requestBelongsToMaxChat(requestId: string, chatId: number): Promise<boolean | 'db_error'> {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM tour_seat_requests r JOIN partners p ON p.id = r.operator_id
        WHERE r.id = $1::uuid AND p.max_chat_id = $2::bigint`,
      [requestId, String(chatId)],
    );
    return rows.length > 0;
  } catch (err) { logFail('принадлежность запроса не проверена', err); return 'db_error'; }
}

/**
 * Принять ответ. Захват атомарный: ответ засчитывается, только если запрос
 * ещё ждёт, срок не вышел, дата тура не прошла (по Камчатке) и никто не
 * ответил раньше. Два нажатия подряд или ответ из двух каналов сразу —
 * выигрывает первый; ответ после полуночи на прошедшую дату не заводит бронь
 * в прошлое.
 */
export async function answerSeatRequest(
  requestId: string,
  answer: OperatorAnswer,
  via: 'max' | 'telegram' | 'web',
): Promise<AnswerResult> {
  if (answer.kind === 'other_date' && !isFutureOrToday(answer.date)) return { ok: false, reason: 'bad_date' };

  let claimed: ClaimedRow | undefined;
  try {
    ({ rows: [claimed] } = await pool.query<ClaimedRow>(
      `UPDATE tour_seat_requests r
          SET answered_at = NOW(), answered_via = $2, updated_at = NOW()
         FROM operator_tours t
        WHERE r.id = $1::uuid AND t.id = r.tour_id
          AND r.status = 'pending' AND r.answered_at IS NULL AND r.deadline_at > NOW()
          AND r.tour_date >= (NOW() AT TIME ZONE 'Asia/Kamchatka')::date
        RETURNING r.id, r.tour_id::text, r.operator_id, r.tour_date::text, r.participants,
                  r.tourist_name, r.tourist_phone, t.title, r.referral_code,
                  r.pd_consent_at, r.pd_consent_ip, r.pd_consent_source, r.pd_consent_version`,
      [requestId, via],
    ));
  } catch (err) { logFail('ответ не захвачен', err); return { ok: false, reason: 'db_error' }; }

  if (!claimed) {
    // Почему не захватилось — отдельным чтением: «уже ответили», «срок
    // вышел», «дата прошла» и «нет такого» — разные слова оператору.
    try {
      const { rows: [r] } = await pool.query<{
        status: SeatRequestStatus; deadline_at: Date; answered_at: Date | null; tour_date: string;
      }>(
        `SELECT status, deadline_at, answered_at, tour_date::text FROM tour_seat_requests WHERE id = $1::uuid`,
        [requestId],
      );
      if (!r) return { ok: false, reason: 'not_found' };
      const st = effectiveStatus(r);
      if (st === 'expired') return { ok: false, reason: 'expired', status: st };
      if (st === 'pending' && r.answered_at === null && r.tour_date < kamchatkaToday()) {
        return { ok: false, reason: 'date_past', status: st };
      }
      return { ok: false, reason: 'already_answered', status: st };
    } catch (err) { logFail('состояние запроса не прочитано', err); return { ok: false, reason: 'db_error' }; }
  }

  let finalStatus: SeatRequestStatus;
  let failureKind: FailureKind | null = null;
  let failureReason: string | null = null;
  let bookingId: number | null = null;
  let accessTokenEnc: string | null = null;
  let altDate: string | null = null;
  let liveBookingUrl: string | null = null;
  let reservedInfo: { bookingId: number; tourTitle: string; totalPrice: number; operatorId: string } | null = null;

  if (answer.kind === 'no') {
    finalStatus = 'declined';
  } else if (answer.kind === 'other_date') {
    finalStatus = 'other_date';
    altDate = answer.date;
  } else {
    // «Есть места» — бронь той же дверью, что сайт и Кузьмич, затем
    // подтверждение. Учёт платформы может не согласиться с оператором (дата
    // закрыта в его же календаре, места заняты другой бронью) — это 'failed'
    // с причиной, а не молчаливая бронь сверх вместимости.
    finalStatus = 'failed';
    try {
      const reserved = await reserveBooking({
        tourId: Number(claimed.tour_id),
        touristName: claimed.tourist_name,
        touristPhone: claimed.tourist_phone,
        participants: claimed.participants,
        date: claimed.tour_date,
        specialRequests: 'Запрос свободных мест: места подтверждены оператором в мессенджере.',
        createdVia: 'seat_request',
        metadata: { seat_request_id: claimed.id },
        referralCode: claimed.referral_code,
        pdConsent: {
          at: claimed.pd_consent_at,
          ip: claimed.pd_consent_ip ?? 'неизвестен',
          source: claimed.pd_consent_source ?? 'seat-request',
          version: claimed.pd_consent_version ?? 'неизвестна',
        },
      });
      bookingId = reserved.bookingId;
      reservedInfo = { bookingId: reserved.bookingId, tourTitle: reserved.tourTitle, totalPrice: reserved.totalPrice, operatorId: reserved.operatorId };
      accessTokenEnc = encrypt(reserved.accessToken);
      if (accessTokenEnc === null) {
        console.error(`[seat-requests] ключ брони ${reserved.bookingId} не зашифрован (ENCRYPTION_KEY) — ссылка уйдёт туристу только сообщением`);
      }
      // Ключ брони в открытом виде живёт только здесь и сейчас — сообщению
      // туристу он нужен немедленно, в базе он лежит зашифрованным.
      liveBookingUrl = `${getPublicBaseUrl()}/booking-success/${reserved.bookingId}?t=${reserved.accessToken}`;
      try {
        await confirmBooking(String(reserved.bookingId), null, 'Места подтверждены оператором в мессенджере (запрос мест)');
        finalStatus = 'confirmed';
      } catch (err) {
        // Бронь создана и держит места, но осталась 'new' — оператор видит её
        // в кабинете как обычную веб-бронь и может подтвердить сам.
        failureKind = 'system';
        failureReason = `бронь #${reserved.bookingId} создана, подтверждение не прошло: ${err instanceof Error ? err.message : 'неизвестно'}`;
        logFail(`бронь ${reserved.bookingId} по запросу ${claimed.id} не подтверждена`, err);
      }
    } catch (err) {
      if (err instanceof ReserveError) {
        failureKind = 'accounting';
        failureReason = `учёт платформы: ${err.message}`;
      } else {
        failureKind = 'system';
        failureReason = `сбой при заведении брони: ${err instanceof Error ? err.message : 'неизвестно'}`;
      }
      logFail(`«Есть места» по запросу ${claimed.id} не превратилось в бронь`, err);
    }
  }

  // Оператору — обычное уведомление о брони (контакты туриста, U-ON), как у
  // веб-формы; иначе он подтвердил бронь и не знает, кому звонить. Оно идёт ДО
  // итоговой записи, а не после: оборвись процесс между ними — уборщик найдёт
  // подтверждённую бронь и уведомит повторно (дубль безвреден), а порядок
  // «запись, потом уведомление» оставлял бы окно, в котором бронь есть, а
  // оператор о ней не знает и записи об этом нет.
  let operatorNotified: boolean | null = null;
  if (finalStatus === 'confirmed' && reservedInfo) {
    const n = await notifyOperatorOfNewBooking({
      bookingId: reservedInfo.bookingId,
      operatorId: reservedInfo.operatorId,
      tourTitle: reservedInfo.tourTitle,
      date: claimed.tour_date,
      participants: claimed.participants,
      totalPrice: reservedInfo.totalPrice,
      touristName: claimed.tourist_name,
      touristPhone: claimed.tourist_phone,
      via: 'seat_request',
    });
    operatorNotified = n.state === 'notified' && n.outcome.state === 'delivered';
  }

  try {
    const { rowCount } = await pool.query(
      `UPDATE tour_seat_requests
          SET status = $2, booking_id = $3, booking_access_token_enc = $4,
              failure_kind = $5, failure_reason = $6, alt_date = $7::date, updated_at = NOW()
        WHERE id = $1::uuid AND status = 'pending'`,
      [claimed.id, finalStatus, bookingId, accessTokenEnc, failureKind, failureReason, altDate],
    );
    if (rowCount === 0) {
      // Уборщик успел раньше нас (процесс завис дольше срока восстановления):
      // исход уже записан им, второй раз не пишем и не уведомляем.
      return { ok: false, reason: 'already_answered', status: finalStatus };
    }
  } catch (err) {
    logFail(`исход запроса ${claimed.id} не записан`, err);
    // Ответ принят, бронь могла завестись. Оператору нельзя говорить «нажмите
    // ещё раз» (второй раз уже не примут) — запрос подберёт уборщик.
    return { ok: false, reason: 'accepted_unfinished' };
  }

  const touristMessage = await notifyTourist(claimed.id, liveBookingUrl);
  return {
    ok: true, status: finalStatus, tourTitle: claimed.title, date: claimed.tour_date,
    failureKind, touristMessage, operatorNotified,
  };
}

// ── 3. Туристу ────────────────────────────────────────────────────────────

interface NotifyRow {
  id: string; status: SeatRequestStatus; deadline_at: Date; answered_at: Date | null;
  reply_channel: ReplyChannel; tourist_chat_id: string | null; tourist_notified_at: Date | null;
  tourist_notify_attempts: number; failure_kind: FailureKind | null;
  tour_title: string; tour_date: string; participants: number; alt_date: string | null;
  booking_id: string | null; booking_access_token_enc: string | null; status_token_enc: string | null;
}

function bookingLink(row: { booking_id: string | null; booking_access_token_enc: string | null }): string | null {
  if (!row.booking_id || !row.booking_access_token_enc) return null;
  const key = decrypt(row.booking_access_token_enc);
  return key ? `${getPublicBaseUrl()}/booking-success/${row.booking_id}?t=${key}` : null;
}

function statusLink(row: { status_token_enc: string | null }): string | null {
  if (!row.status_token_enc) return null;
  const token = decrypt(row.status_token_enc);
  return token ? statusUrl(token) : null;
}

/**
 * Отправить исход туристу, если он подключил чат, и отметить отправку.
 * Страница статуса работает всегда; сообщение — удобство, а не единственный
 * путь. Повторно не шлёт: `tourist_notified_at` ставится только при успехе;
 * при отказе растёт счётчик попыток, и уборщик повторит (потолок —
 * MAX_TOURIST_NOTIFY_ATTEMPTS).
 */
export async function notifyTourist(
  requestId: string,
  liveBookingUrl: string | null = null,
): Promise<TouristMessageState> {
  let row: NotifyRow | undefined;
  try {
    ({ rows: [row] } = await pool.query<NotifyRow>(
      `SELECT r.id, r.status, r.deadline_at, r.answered_at, r.reply_channel,
              r.tourist_chat_id::text, r.tourist_notified_at, r.tourist_notify_attempts, r.failure_kind,
              t.title AS tour_title, r.tour_date::text, r.participants, r.alt_date::text,
              r.booking_id::text, r.booking_access_token_enc, r.status_token_enc
         FROM tour_seat_requests r JOIN operator_tours t ON t.id = r.tour_id
        WHERE r.id = $1::uuid`,
      [requestId],
    ));
  } catch (err) { logFail('запрос для уведомления туриста не прочитан', err); return 'failed'; }
  if (!row) return 'failed';

  const status = effectiveStatus(row);
  if (status === 'pending') return 'not_final';
  if (row.tourist_notified_at) return 'sent';
  if (!row.tourist_chat_id || (row.reply_channel !== 'telegram' && row.reply_channel !== 'max')) return 'no_chat';

  const text = touristOutcomeText(
    { status, tour_title: row.tour_title, tour_date: row.tour_date, participants: row.participants, alt_date: row.alt_date, failure_kind: row.failure_kind },
    { statusUrl: statusLink(row), bookingUrl: liveBookingUrl ?? bookingLink(row) },
  );
  const sent = row.reply_channel === 'telegram'
    ? (await telegramService.sendMessage({ chatId: row.tourist_chat_id, text })).success
    : (await maxSendDm(row.tourist_chat_id, text)).ok;
  if (!sent) {
    console.error(`[seat-requests] исход запроса ${row.id} не доставлен туристу в ${row.reply_channel} (попытка ${row.tourist_notify_attempts + 1})`);
    try {
      await pool.query(`UPDATE tour_seat_requests SET tourist_notify_attempts = tourist_notify_attempts + 1 WHERE id = $1::uuid`, [row.id]);
    } catch (err) { logFail('счётчик попыток уведомления не записан', err); }
    return 'failed';
  }
  try {
    await pool.query(`UPDATE tour_seat_requests SET tourist_notified_at = NOW() WHERE id = $1::uuid`, [row.id]);
  } catch (err) { logFail('отметка об уведомлении туриста не записана', err); }
  return 'sent';
}

/**
 * Турист нажал «Старт» в боте по ссылке со страницы статуса — запоминаем чат.
 * Если ответ уже есть, он уходит сразу.
 */
export async function bindTouristChat(
  statusToken: string,
  channel: 'telegram' | 'max',
  chatId: number,
): Promise<{ ok: true; notified: boolean } | { ok: false; reason: 'not_found' | 'already_bound' | 'db_error' }> {
  let id: string | undefined;
  try {
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE tour_seat_requests
          SET tourist_chat_id = $2::bigint, reply_channel = $3, updated_at = NOW()
        WHERE status_token_hash = $1
          AND (tourist_chat_id IS NULL OR tourist_chat_id = $2::bigint)
        RETURNING id`,
      [hashStatusToken(statusToken), String(chatId), channel],
    );
    id = rows[0]?.id;
  } catch (err) { logFail('чат туриста не записан', err); return { ok: false, reason: 'db_error' }; }
  if (!id) {
    // Ключ верный, но к запросу уже подключён ДРУГОЙ чат: перезаписать его
    // значило бы дать тому, кто узнал ключ, получить исход и ссылку на бронь.
    try {
      const { rows } = await pool.query(`SELECT 1 FROM tour_seat_requests WHERE status_token_hash = $1`, [hashStatusToken(statusToken)]);
      return { ok: false, reason: rows.length > 0 ? 'already_bound' : 'not_found' };
    } catch (err) { logFail('запрос для проверки привязки не прочитан', err); return { ok: false, reason: 'db_error' }; }
  }
  const res = await notifyTourist(id);
  return { ok: true, notified: res === 'sent' };
}

// ── 4. Страница статуса ───────────────────────────────────────────────────

export interface SeatRequestView {
  status: SeatRequestStatus;
  tourId: string;
  tourTitle: string;
  date: string;
  participants: number;
  altDate: string | null;
  deadlineAt: string;
  replyChannel: ReplyChannel;
  touristChatBound: boolean;
  /** Сообщение с исходом в мессенджер действительно ушло. */
  touristNotified: boolean;
  /** Почему 'failed': «исход неизвестен» и «не завелась бронь» — разные тексты. */
  failureKind: FailureKind | null;
  bookingUrl: string | null;
}

export async function readSeatRequest(statusToken: string): Promise<SeatRequestView | null | 'db_error'> {
  let row: (NotifyRow & { tour_id: string }) | undefined;
  try {
    ({ rows: [row] } = await pool.query<NotifyRow & { tour_id: string }>(
      `SELECT r.id, r.status, r.deadline_at, r.answered_at, r.reply_channel,
              r.tourist_chat_id::text, r.tourist_notified_at, r.tourist_notify_attempts, r.failure_kind,
              t.title AS tour_title, r.tour_id::text,
              r.tour_date::text, r.participants, r.alt_date::text, r.booking_id::text,
              r.booking_access_token_enc, r.status_token_enc
         FROM tour_seat_requests r JOIN operator_tours t ON t.id = r.tour_id
        WHERE r.status_token_hash = $1`,
      [hashStatusToken(statusToken)],
    ));
  } catch (err) { logFail('статус запроса не прочитан', err); return 'db_error'; }
  if (!row) return null;
  return {
    status: effectiveStatus(row),
    tourId: row.tour_id,
    tourTitle: row.tour_title,
    date: row.tour_date,
    participants: row.participants,
    altDate: row.alt_date,
    deadlineAt: new Date(row.deadline_at).toISOString(),
    replyChannel: row.reply_channel,
    touristChatBound: row.tourist_chat_id !== null,
    touristNotified: row.tourist_notified_at !== null,
    failureKind: row.failure_kind,
    bookingUrl: bookingLink(row),
  };
}

/** То, что оператор видит на странице ответа: без ПД туриста. */
export async function readForOperator(requestId: string): Promise<
  { status: SeatRequestStatus; tourTitle: string; date: string; participants: number; deadlineAt: string } | null | 'db_error'
> {
  try {
    const { rows: [r] } = await pool.query<{
      status: SeatRequestStatus; deadline_at: Date; answered_at: Date | null; title: string; tour_date: string; participants: number;
    }>(
      `SELECT r.status, r.deadline_at, r.answered_at, t.title, r.tour_date::text, r.participants
         FROM tour_seat_requests r JOIN operator_tours t ON t.id = r.tour_id
        WHERE r.id = $1::uuid`,
      [requestId],
    );
    if (!r) return null;
    return { status: effectiveStatus(r), tourTitle: r.title, date: r.tour_date, participants: r.participants, deadlineAt: new Date(r.deadline_at).toISOString() };
  } catch (err) { logFail('запрос для оператора не прочитан', err); return 'db_error'; }
}

// ── 5. Уборщик ────────────────────────────────────────────────────────────

/**
 * Подобрать запросы, у которых ответ ПРИНЯТ, а исход не записан: процесс
 * оборвался между захватом и итоговой записью (деплой, обрыв соединения).
 * Без этого такой запрос вечно показывал «ждём ответа», а повторное нажатие
 * оператора упиралось в «уже ответили».
 *
 * Правда берётся из базы, а не угадывается: бронь ищется по метке
 * `metadata.seat_request_id`, которую reserveBooking записал в неё же.
 *   - бронь есть и подтверждена → 'confirmed';
 *   - бронь есть, не подтверждена → 'failed'/system, бронь остаётся у оператора;
 *   - брони нет → 'failed'/unfinished: ответ «есть» не превратился ни во что.
 * 'declined' и 'other_date' восстановить нечем — ответ оператора (что именно
 * он нажал) до записи исхода не сохраняется, — поэтому такой запрос честно
 * 'failed'/unfinished, и человек выясняет ответ у оператора.
 */
export async function recoverUnfinished(): Promise<{ recovered: number; failed: number }> {
  const { rows } = await pool.query<{ id: string; tour_date: string; participants: number; tourist_name: string; tourist_phone: string; operator_id: string; title: string }>(
    `SELECT r.id, r.tour_date::text, r.participants, r.tourist_name, r.tourist_phone, r.operator_id, t.title
       FROM tour_seat_requests r JOIN operator_tours t ON t.id = r.tour_id
      WHERE r.status = 'pending' AND r.answered_at IS NOT NULL
        AND r.answered_at < NOW() - ($1 || ' minutes')::INTERVAL`,
    [String(UNFINISHED_AFTER_MINUTES)],
  );
  let recovered = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const { rows: [b] } = await pool.query<{ id: string; booking_status: string; final_price: string | null; access_token: string }>(
        `SELECT id::text, booking_status, COALESCE(final_price, base_total_price)::text AS final_price,
                access_token::text AS access_token
           FROM operator_bookings
          WHERE metadata->>'seat_request_id' = $1 AND deleted_at IS NULL
          ORDER BY id DESC LIMIT 1`,
        [r.id],
      );
      let status: SeatRequestStatus = 'failed';
      let tokenEnc: string | null = null;
      let kind: FailureKind | null = 'unfinished';
      let reason: string | null = 'ответ принят, а исход не записан (процесс оборвался); что именно ответил оператор, восстановить нечем';
      if (b && b.booking_status === 'confirmed') {
        status = 'confirmed'; kind = null; reason = null;
        // Ключ брони лежит в самой брони: без него турист получал бы круг из
        // двух текстов «ссылка на странице запроса» / «ссылка в мессенджере» и
        // не нашёл бы её нигде.
        tokenEnc = encrypt(b.access_token);
        if (tokenEnc === null) console.error(`[seat-requests] ключ брони ${b.id} не зашифрован (ENCRYPTION_KEY) — ссылка на оплату в запросе не сохранена`);
      } else if (b) {
        kind = 'system';
        reason = `бронь #${b.id} создана, но осталась «${b.booking_status}» (процесс оборвался до подтверждения)`;
      }
      const upd = await pool.query(
        `UPDATE tour_seat_requests
            SET status = $2, booking_id = $3::bigint, failure_kind = $4, failure_reason = $5,
                booking_access_token_enc = COALESCE($6, booking_access_token_enc), updated_at = NOW()
          WHERE id = $1::uuid AND status = 'pending' AND answered_at IS NOT NULL`,
        [r.id, status, b?.id ?? null, kind, reason, tokenEnc],
      );
      if ((upd.rowCount ?? 0) === 0) continue;
      if (status === 'confirmed') {
        recovered++;
        // Уведомление оператору могло не успеть уйти; дубль безвреден, тишина — нет.
        await notifyOperatorOfNewBooking({
          bookingId: b!.id, operatorId: r.operator_id, tourTitle: r.title, date: r.tour_date,
          participants: r.participants, totalPrice: Number(b!.final_price ?? 0),
          touristName: r.tourist_name, touristPhone: r.tourist_phone, via: 'seat_request',
        });
      } else {
        failed++;
      }
    } catch (err) { logFail(`незавершённый запрос ${r.id} не подобран`, err); }
  }
  return { recovered, failed };
}

/**
 * Закрыть просроченные запросы, подобрать незавершённые и сообщить туристам.
 * Срок и без этого виден читателям (effectiveStatus); уборщик нужен, чтобы
 * статус в базе совпадал с правдой и чтобы турист получил сообщение, а не
 * ждал его. Сообщения, не дошедшие раньше, повторяются (потолок попыток,
 * сутки давности).
 */
export async function expireOverdue(): Promise<{
  expired: number; recovered: number; unfinished_failed: number; notified: number; notify_failed: number;
}> {
  const { rows: expired } = await pool.query<{ id: string }>(
    `UPDATE tour_seat_requests
        SET status = 'expired', updated_at = NOW()
      WHERE status = 'pending' AND answered_at IS NULL AND deadline_at <= NOW()
      RETURNING id`,
  );
  const rec = await recoverUnfinished();

  const { rows: unnotified } = await pool.query<{ id: string }>(
    `SELECT id FROM tour_seat_requests
      WHERE status <> 'pending' AND tourist_notified_at IS NULL AND tourist_chat_id IS NOT NULL
        AND reply_channel IN ('telegram', 'max')
        AND tourist_notify_attempts < $1
        AND updated_at > NOW() - INTERVAL '24 hours'`,
    [MAX_TOURIST_NOTIFY_ATTEMPTS],
  );
  let notified = 0;
  let notifyFailed = 0;
  for (const r of unnotified) {
    const res = await notifyTourist(r.id);
    if (res === 'sent') notified++;
    if (res === 'failed') notifyFailed++;
  }
  return {
    expired: expired.length, recovered: rec.recovered, unfinished_failed: rec.failed,
    notified, notify_failed: notifyFailed,
  };
}
