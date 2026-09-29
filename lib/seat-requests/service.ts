/**
 * Запрос свободных мест у оператора — работа с базой и каналами.
 *
 * Поток (решения владельца 29.09):
 *   1. турист из планера спрашивает тур, дату и число людей (createSeatRequest);
 *   2. оператору уходит сообщение с кнопками «Есть места» / «Мест нет» и
 *      ссылкой «Другая дата» — в MAX с именем и телефоном туриста, в Telegram
 *      заглушкой без ПД со ссылкой на страницу ответа (lib/notifications/pd-alert);
 *   3. «Есть места» СРАЗУ заводит бронь той же дверью, что сайт и Кузьмич
 *      (reserveBooking), и подтверждает её (confirmBooking): ответ оператора и
 *      есть подтверждение, второго шага в кабинете ему не нужно;
 *   4. через 2 часа без ответа — 'expired', «оператор не ответил» (не «мест нет»);
 *   5. исход уходит туристу в его мессенджер, если он подключил чат, и всегда
 *      виден на странице статуса.
 *
 * Отказы не глушатся (§4.0): каждый выход в «не смог» пишет причину в лог и
 * возвращает её вызывающему.
 */

import { pool } from '@/lib/db-pool';
import { getPublicBaseUrl } from '@/lib/config';
import { reachForPartner } from '@/lib/partners/reach';
import { sendPdAlert } from '@/lib/notifications/pd-alert';
import { telegramService } from '@/lib/notifications/telegram';
import { maxSendDm } from '@/lib/notifications/max-channel';
import { reserveBooking, ReserveError } from '@/lib/bookings/reserve';
import { confirmBooking } from '@/lib/bookings/booking.service';
import { encrypt, decrypt } from '@/lib/encryption';
import { telegramBot, maxBot } from '@/lib/partners/channel-link';
import type { PdConsentRecord } from '@/lib/legal/pd-consent';
import {
  SEAT_REQUEST_DEADLINE_MS, answerPayload, effectiveStatus, hashStatusToken,
  isFutureOrToday, newStatusToken, operatorAnswerKey, touristOutcomeText, TOURIST_START_PREFIX,
  type OperatorAnswer, type ReplyChannel, type SeatRequestStatus,
} from '@/lib/seat-requests/core';

function logFail(where: string, err: unknown): void {
  const e = err as { message?: string; code?: string };
  console.error(`[seat-requests] ${where}:`, e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function statusUrl(token: string): string {
  return `${getPublicBaseUrl()}/seat-request/${token}`;
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
  source?: string;
}

export type CreateSeatRequestResult =
  | { ok: true; requestId: string; statusToken: string; deadlineAt: Date; operatorDelivery: 'max' | 'telegram-stub' }
  | { ok: false; reason: 'date_past' | 'tour_not_found' | 'operator_unreachable' | 'check_failed' | 'delivery_failed' };

export async function createSeatRequest(input: CreateSeatRequestInput): Promise<CreateSeatRequestResult> {
  if (!isFutureOrToday(input.date)) return { ok: false, reason: 'date_past' };

  let tour: { operator_id: string; title: string } | undefined;
  try {
    ({ rows: [tour] } = await pool.query<{ operator_id: string; title: string }>(
      `SELECT operator_id, title FROM operator_tours
        WHERE id = $1 AND is_active = true AND is_published = true AND deleted_at IS NULL`,
      [input.tourId],
    ));
  } catch (err) { logFail('тур не прочитан', err); return { ok: false, reason: 'check_failed' }; }
  if (!tour) return { ok: false, reason: 'tour_not_found' };

  // Оператору некуда написать — запрос не заводится вовсе. Иначе турист
  // ждал бы два часа ответа, которого не может быть, и получил бы «оператор
  // не ответил» — ложь о человеке, которому никто не писал.
  const reach = await reachForPartner(tour.operator_id);
  if (reach === null) return { ok: false, reason: 'check_failed' };
  if (!reach.reachable) return { ok: false, reason: 'operator_unreachable' };

  const { token, hash } = newStatusToken();
  const deadlineAt = new Date(Date.now() + SEAT_REQUEST_DEADLINE_MS);
  let requestId: string;
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tour_seat_requests
         (tour_id, operator_id, tour_date, participants, tourist_name, tourist_phone,
          reply_channel, status_token_hash, deadline_at, source,
          pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [input.tourId, tour.operator_id, input.date, input.participants, input.touristName,
       input.touristPhone, input.replyChannel, hash, deadlineAt, input.source ?? 'planner',
       input.pdConsent.at, input.pdConsent.ip, input.pdConsent.source, input.pdConsent.version],
    );
    requestId = rows[0]!.id;
  } catch (err) { logFail('запрос не записан', err); return { ok: false, reason: 'check_failed' }; }

  const answerUrl = operatorAnswerUrl(requestId);
  const what = `«${esc(tour.title)}», ${input.date}, ${input.participants} чел.`;
  const deadlineLocal = deadlineAt.toLocaleTimeString('ru-RU', { timeZone: 'Asia/Kamchatka', hour: '2-digit', minute: '2-digit' });
  const delivery = await sendPdAlert({
    text: [
      '<b>Запрос свободных мест</b>',
      what,
      `Турист: ${esc(input.touristName)}, ${esc(input.touristPhone)}`,
      '',
      `Ответьте до ${deadlineLocal} (по Камчатке). «Есть места» — бронь сразу заводится и подтверждается, турист получает ссылку на оплату.`,
    ].join('\n'),
    stub: [
      `Запрос свободных мест: ${what}`,
      `Ответьте до ${deadlineLocal} (по Камчатке) по ссылке ниже. Контакты туриста придут после подтверждения — в кабинет и в MAX.`,
    ].join('\n'),
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
  | { ok: true; status: SeatRequestStatus; tourTitle: string; date: string }
  | { ok: false; reason: 'not_found' | 'already_answered' | 'expired' | 'bad_date' | 'db_error'; status?: SeatRequestStatus };

interface ClaimedRow {
  id: string; tour_id: string; operator_id: string; tour_date: string; participants: number;
  tourist_name: string; tourist_phone: string; title: string;
  pd_consent_at: Date; pd_consent_ip: string | null; pd_consent_source: string | null; pd_consent_version: string | null;
}

/**
 * Принять ответ. Захват атомарный: ответ засчитывается, только если запрос
 * ещё ждёт, срок не вышел и никто не ответил раньше (`answered_at IS NULL`).
 * Два нажатия подряд или ответ из двух каналов сразу — выигрывает первый.
 */
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
        RETURNING r.id, r.tour_id::text, r.operator_id, r.tour_date::text, r.participants,
                  r.tourist_name, r.tourist_phone, t.title,
                  r.pd_consent_at, r.pd_consent_ip, r.pd_consent_source, r.pd_consent_version`,
      [requestId, via],
    ));
  } catch (err) { logFail('ответ не захвачен', err); return { ok: false, reason: 'db_error' }; }

  if (!claimed) {
    // Почему не захватилось — отдельным чтением: «уже ответили», «срок
    // вышел» и «нет такого» — разные слова оператору.
    try {
      const { rows: [r] } = await pool.query<{ status: SeatRequestStatus; deadline_at: Date; answered_at: Date | null }>(
        `SELECT status, deadline_at, answered_at FROM tour_seat_requests WHERE id = $1::uuid`, [requestId],
      );
      if (!r) return { ok: false, reason: 'not_found' };
      const st = effectiveStatus(r);
      return { ok: false, reason: st === 'expired' ? 'expired' : 'already_answered', status: st };
    } catch (err) { logFail('состояние запроса не прочитано', err); return { ok: false, reason: 'db_error' }; }
  }

  let finalStatus: SeatRequestStatus;
  let bookingId: number | null = null;
  let accessTokenEnc: string | null = null;
  let failureReason: string | null = null;
  let altDate: string | null = null;
  let liveBookingUrl: string | null = null;

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
    try {
      const reserved = await reserveBooking({
        tourId: Number(claimed.tour_id),
        touristName: claimed.tourist_name,
        touristPhone: claimed.tourist_phone,
        participants: claimed.participants,
        date: claimed.tour_date,
        specialRequests: 'Запрос свободных мест из планера: места подтверждены оператором в мессенджере.',
        createdVia: 'seat_request',
        metadata: { seat_request_id: claimed.id },
        pdConsent: {
          at: claimed.pd_consent_at,
          ip: claimed.pd_consent_ip ?? 'неизвестен',
          source: claimed.pd_consent_source ?? 'seat-request',
          version: claimed.pd_consent_version ?? 'неизвестна',
        },
      });
      bookingId = reserved.bookingId;
      accessTokenEnc = encrypt(reserved.accessToken);
      if (accessTokenEnc === null) {
        console.error(`[seat-requests] ключ брони ${reserved.bookingId} не зашифрован (ENCRYPTION_KEY) — ссылка уйдёт туристу только сообщением`);
      }
      await confirmBooking(String(reserved.bookingId), null, 'Места подтверждены оператором в мессенджере (запрос мест)');
      finalStatus = 'confirmed';
      // Ключ брони в открытом виде живёт только здесь и сейчас — сообщению
      // туристу он нужен немедленно, в базе он лежит зашифрованным.
      liveBookingUrl = `${getPublicBaseUrl()}/booking-success/${reserved.bookingId}?t=${reserved.accessToken}`;
    } catch (err) {
      finalStatus = 'failed';
      failureReason = err instanceof ReserveError
        ? `учёт платформы: ${err.message}`
        : `сбой при заведении брони: ${err instanceof Error ? err.message : 'неизвестно'}`;
      logFail(`«Есть места» по запросу ${claimed.id} не превратилось в бронь`, err);
      // Бронь могла завестись, а подтверждение — упасть: тогда она остаётся
      // 'new' у оператора в кабинете, и запрос ссылается на неё.
    }
  }

  try {
    await pool.query(
      `UPDATE tour_seat_requests
          SET status = $2, booking_id = $3, booking_access_token_enc = $4,
              failure_reason = $5, alt_date = $6::date, updated_at = NOW()
        WHERE id = $1::uuid`,
      [claimed.id, finalStatus, bookingId, accessTokenEnc, failureReason, altDate],
    );
  } catch (err) {
    logFail(`исход запроса ${claimed.id} не записан`, err);
    return { ok: false, reason: 'db_error' };
  }

  await notifyTourist(claimed.id, liveBookingUrl);
  return { ok: true, status: finalStatus, tourTitle: claimed.title, date: claimed.tour_date };
}

// ── 3. Туристу ────────────────────────────────────────────────────────────

interface NotifyRow {
  id: string; status: SeatRequestStatus; deadline_at: Date; answered_at: Date | null;
  reply_channel: ReplyChannel; tourist_chat_id: string | null; tourist_notified_at: Date | null;
  tour_title: string; tour_date: string; participants: number; alt_date: string | null;
  booking_id: string | null; booking_access_token_enc: string | null; status_token_hash: string;
}

function bookingLink(row: { booking_id: string | null; booking_access_token_enc: string | null }): string | null {
  if (!row.booking_id || !row.booking_access_token_enc) return null;
  const key = decrypt(row.booking_access_token_enc);
  return key ? `${getPublicBaseUrl()}/booking-success/${row.booking_id}?t=${key}` : null;
}

/**
 * Отправить исход туристу, если он подключил чат, и отметить отправку.
 * Страница статуса работает всегда; сообщение — удобство, а не единственный
 * путь. Повторно не шлёт: `tourist_notified_at` ставится только при успехе.
 */
export async function notifyTourist(
  requestId: string,
  liveBookingUrl: string | null = null,
): Promise<'sent' | 'no_chat' | 'not_final' | 'failed'> {
  let row: NotifyRow | undefined;
  try {
    ({ rows: [row] } = await pool.query<NotifyRow>(
      `SELECT r.id, r.status, r.deadline_at, r.answered_at, r.reply_channel,
              r.tourist_chat_id::text, r.tourist_notified_at, t.title AS tour_title,
              r.tour_date::text, r.participants, r.alt_date::text, r.booking_id::text,
              r.booking_access_token_enc, r.status_token_hash
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

  // Ссылку на страницу статуса собрать нельзя — её ключ у туриста, у нас
  // только хэш. Поэтому «куда дальше» — планер, а ссылка на бронь (там, где
  // она есть) — ключевая, из шифра или из только что заведённой брони.
  const text = touristOutcomeText(
    { status, tour_title: row.tour_title, tour_date: row.tour_date, participants: row.participants, alt_date: row.alt_date },
    { statusUrl: `${getPublicBaseUrl()}/planner`, bookingUrl: liveBookingUrl ?? bookingLink(row) },
  );
  const sent = row.reply_channel === 'telegram'
    ? (await telegramService.sendMessage({ chatId: row.tourist_chat_id, text })).success
    : (await maxSendDm(row.tourist_chat_id, text)).ok;
  if (!sent) {
    console.error(`[seat-requests] исход запроса ${row.id} не доставлен туристу в ${row.reply_channel}`);
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
): Promise<{ ok: true; notified: boolean } | { ok: false; reason: 'not_found' | 'db_error' }> {
  let id: string | undefined;
  try {
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE tour_seat_requests
          SET tourist_chat_id = $2::bigint, reply_channel = $3, updated_at = NOW()
        WHERE status_token_hash = $1
        RETURNING id`,
      [hashStatusToken(statusToken), String(chatId), channel],
    );
    id = rows[0]?.id;
  } catch (err) { logFail('чат туриста не записан', err); return { ok: false, reason: 'db_error' }; }
  if (!id) return { ok: false, reason: 'not_found' };
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
  bookingUrl: string | null;
}

export async function readSeatRequest(statusToken: string): Promise<SeatRequestView | null | 'db_error'> {
  let row: (NotifyRow & { tour_id: string }) | undefined;
  try {
    ({ rows: [row] } = await pool.query<NotifyRow & { tour_id: string }>(
      `SELECT r.id, r.status, r.deadline_at, r.answered_at, r.reply_channel,
              r.tourist_chat_id::text, r.tourist_notified_at, t.title AS tour_title, r.tour_id::text,
              r.tour_date::text, r.participants, r.alt_date::text, r.booking_id::text,
              r.booking_access_token_enc, r.status_token_hash
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

// ── 5. Просрочка ──────────────────────────────────────────────────────────

/**
 * Закрыть просроченные запросы и сообщить туристам. Срок и без этого виден
 * читателям (effectiveStatus); уборщик нужен, чтобы статус в базе совпадал с
 * правдой и чтобы турист получил сообщение, а не ждал его.
 */
export async function expireOverdue(): Promise<{ expired: number; notified: number; notifyFailed: number }> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE tour_seat_requests
        SET status = 'expired', updated_at = NOW()
      WHERE status = 'pending' AND answered_at IS NULL AND deadline_at <= NOW()
      RETURNING id`,
  );
  let notified = 0;
  let notifyFailed = 0;
  for (const r of rows) {
    const res = await notifyTourist(r.id);
    if (res === 'sent') notified++;
    if (res === 'failed') notifyFailed++;
  }
  return { expired: rows.length, notified, notifyFailed };
}
