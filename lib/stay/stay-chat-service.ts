/**
 * lib/stay/stay-chat-service.ts — переписка хозяина жилья и гостя по заявке:
 * запись, доставка второй стороне, ожидание сообщения после кнопки и
 * подключение чата MAX гостя (1348, #2843). Правила и тексты —
 * `lib/stay/stay-chat.ts`.
 *
 * Двери три, правило одно:
 *   - чат MAX хозяина — кнопка «Ответить гостю» под заявкой, затем текст
 *     (`armStayChatWait` → `captureStayChatText`);
 *   - чат MAX гостя — «Старт» по ссылке со страницы заявки
 *     (`bindGuestChat`), кнопка «Написать владельцу», затем текст;
 *   - страница заявки (`/request-status#<ключ>`) — `readStayChat` и
 *     `postGuestMessage` по ключу статуса заявки (1238).
 *
 * Кто вправе:
 *   - хозяин — чат, привязанный к партнёру объекта (`partners.max_chat_id`);
 *     сверяется на кнопке и ещё раз при отправке: чат могли перепривязать;
 *   - гость в MAX — чат, подключённый к заявке ключом (`guest_max_chat_id`);
 *   - гость на странице — держатель ключа статуса. Ключ получили только
 *     человек и, если заявку оставил помощник через MCP, этот помощник; в
 *     ответы инструментов текст переписки не уходит (get_request_status его
 *     не читает).
 *
 * Исходы честные (§4.0): «не дошло» и «гость не подключил MAX» — разные
 * значения в `delivery_channel`, отказ базы — SQLSTATE в лог и свой ответ,
 * а не «нет заявки». Сообщение гостя, не дошедшее до хозяина, уходит
 * оператору платформы — он передаст. В ленту CRM пишется факт сообщения без
 * текста.
 */
import { createHash } from 'node:crypto';
import { pool } from '@/lib/db-pool';
import { getPublicBaseUrl } from '@/lib/config';
import { sendPdAlert, type PdAlertButton } from '@/lib/notifications/pd-alert';
import { maxSendDm } from '@/lib/notifications/max-channel';
import { recordSourceEventQuietly } from '@/lib/crm/events';
import { REQUEST_KEY_MIN_CHARS, REQUEST_KEY_MAX_CHARS } from '@/lib/mcp/request-status-schema';
import { STAY_REQUESTS_ADMIN_PATH } from '@/lib/stay/stay-request';
import { roleMenuAsk } from '@/lib/roles/role-menu';
import {
  STAY_CHAT_BUTTON, STAY_CHAT_GUEST_DAILY_LIMIT, STAY_CHAT_TEXT, STAY_CHAT_WAIT_MIN,
  guestBoundText, guestIncomingText, isCancelText, normalizeChatText, ownerIncomingStub, ownerIncomingText,
  platformIncomingStub, platformIncomingText, sentReplyText, stayChatPressPayload, waitPrompt,
  type StayChatDelivery, type StayChatRequestFacts, type StayChatSide,
} from '@/lib/stay/stay-chat';

function logFail(where: string, err: unknown): void {
  const e = err as { message?: string; code?: string };
  console.error(`[stay-chat] ${where}:`, e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
}

const KEY_RE = /^[A-Za-z0-9_-]+$/;

/** Ключ той формы, что выдаёт issueRequestKey; иначе null — в базу не ходим. */
function keyHash(raw: unknown): string | null {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key.length < REQUEST_KEY_MIN_CHARS || key.length > REQUEST_KEY_MAX_CHARS || !KEY_RE.test(key)) return null;
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

interface RequestRow {
  id: string;
  accommodation_name: string;
  check_in: string;
  check_out: string;
  guests: number;
  guest_name: string;
  guest_max_chat_id: string | null;
  partner_id: string | null;
  owner_max_chat_id: string | null;
  owner_telegram_chat_id: string | null;
}

export const STAY_CHAT_REQUEST_SQL = `
  SELECT s.id::text AS id, a.name AS accommodation_name,
         s.check_in_date::text AS check_in, s.check_out_date::text AS check_out, s.guests,
         s.guest_name, s.guest_max_chat_id::text AS guest_max_chat_id,
         a.partner_id::text AS partner_id,
         p.max_chat_id::text AS owner_max_chat_id, p.telegram_chat_id::text AS owner_telegram_chat_id
    FROM stay_requests s
    JOIN accommodations a ON a.id = s.accommodation_id
    LEFT JOIN partners p ON p.id = a.partner_id
   WHERE s.id = $1::uuid`;

/** Строка заявки; undefined — нет такой. Бросает при отказе базы. */
async function readRequest(requestId: string): Promise<RequestRow | undefined> {
  const { rows } = await pool.query<RequestRow>(STAY_CHAT_REQUEST_SQL, [requestId]);
  return rows[0];
}

function factsOf(r: RequestRow): StayChatRequestFacts {
  return { accommodationName: r.accommodation_name, checkIn: r.check_in, checkOut: r.check_out, guests: r.guests };
}

/** Заявка по ключу статуса: только живой ключ и только заявка на жильё. */
export const STAY_CHAT_KEY_SQL = `
  SELECT k.stay_request_id::text AS id
    FROM agent_request_keys k
   WHERE k.key_hash = $1 AND k.expires_at > NOW() AND k.stay_request_id IS NOT NULL`;

// ── Страница заявки ──────────────────────────────────────────────────────────

export interface StayChatMessageView {
  author: StayChatSide;
  body: string;
  at: string;
}

export type StayChatRead =
  | { outcome: 'ok'; facts: StayChatRequestFacts; guestBound: boolean; ownerOnMax: boolean; messages: StayChatMessageView[] }
  | { outcome: 'bad_key' }
  | { outcome: 'not_found' }
  | { outcome: 'unavailable' };

export const STAY_CHAT_MESSAGES_SQL = `
  SELECT author, body, created_at
    FROM stay_request_messages
   WHERE stay_request_id = $1::uuid
   ORDER BY created_at, id
   LIMIT 200`;

/**
 * Переписка для страницы заявки. Отдаётся автор, текст и время — без имени и
 * телефона гостя (человек их знает сам) и без адресов чатов.
 */
export async function readStayChat(rawKey: unknown): Promise<StayChatRead> {
  const hash = keyHash(rawKey);
  if (!hash) return { outcome: 'bad_key' };
  try {
    const { rows: [k] } = await pool.query<{ id: string }>(STAY_CHAT_KEY_SQL, [hash]);
    if (!k) return { outcome: 'not_found' };
    const r = await readRequest(k.id);
    if (!r) return { outcome: 'not_found' };
    const { rows } = await pool.query<{ author: StayChatSide; body: string; created_at: Date | string }>(
      STAY_CHAT_MESSAGES_SQL, [k.id],
    );
    return {
      outcome: 'ok',
      facts: factsOf(r),
      guestBound: r.guest_max_chat_id !== null,
      ownerOnMax: r.owner_max_chat_id !== null,
      messages: rows.map((m) => ({
        author: m.author,
        body: m.body,
        at: (m.created_at instanceof Date ? m.created_at : new Date(m.created_at)).toISOString(),
      })),
    };
  } catch (err) {
    logFail('переписка не прочитана', err);
    return { outcome: 'unavailable' };
  }
}

/** Заявка по ключу для отправки со страницы. */
export async function stayRequestIdByKey(rawKey: unknown): Promise<{ outcome: 'ok'; id: string } | { outcome: 'bad_key' | 'not_found' | 'unavailable' }> {
  const hash = keyHash(rawKey);
  if (!hash) return { outcome: 'bad_key' };
  try {
    const { rows: [k] } = await pool.query<{ id: string }>(STAY_CHAT_KEY_SQL, [hash]);
    return k ? { outcome: 'ok', id: k.id } : { outcome: 'not_found' };
  } catch (err) {
    logFail('ключ заявки не проверен', err);
    return { outcome: 'unavailable' };
  }
}

// ── Запись и доставка ────────────────────────────────────────────────────────

export type PostResult =
  | { outcome: 'sent'; delivery: StayChatDelivery }
  | { outcome: 'not_found' | 'daily_limit' | 'save_failed' | 'bad_text'; error?: string };

async function insertMessage(requestId: string, author: StayChatSide, door: 'max' | 'page', body: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO stay_request_messages (stay_request_id, author, door, body)
     VALUES ($1::uuid, $2, $3, $4)
     RETURNING id::text AS id`,
    [requestId, author, door, body],
  );
  return rows[0].id;
}

async function recordDelivery(messageId: string, delivery: StayChatDelivery, reason: string): Promise<void> {
  try {
    await pool.query(
      `UPDATE stay_request_messages SET delivery_channel = $2, delivery_reason = $3 WHERE id = $1::uuid`,
      [messageId, delivery, reason.slice(0, 300)],
    );
  } catch (err) {
    // Сообщение уже записано и отправлено: исход доставки — «не записан», а не «не дошло».
    logFail('исход доставки сообщения не записан', err);
  }
}

function crmEvent(r: RequestRow, author: StayChatSide, door: 'max' | 'page', delivery: StayChatDelivery): Promise<void> {
  if (!r.partner_id) return Promise.resolve();
  return recordSourceEventQuietly({
    kind: author === 'guest' ? 'message_in' : 'message_out',
    sourceKind: 'stay_request',
    sourceId: r.id,
    actorKind: author === 'guest' ? 'tourist' : 'partner_user',
    title: author === 'guest' ? 'Заявка на жильё: сообщение гостя' : 'Заявка на жильё: ответ владельца в переписке',
    // Текст в ленту не пишется: свободный текст может нести что угодно.
    payload: { door, delivery },
  });
}

/**
 * Сообщение гостя хозяину. ПД (имя гостя) — только в MAX хозяина; не дошло —
 * оператору платформы, он передаст. Сутки — не больше
 * `STAY_CHAT_GUEST_DAILY_LIMIT` сообщений по заявке.
 */
export async function postGuestMessage(requestId: string, rawBody: unknown, door: 'max' | 'page'): Promise<PostResult> {
  const t = normalizeChatText(rawBody);
  if (!t.ok) return { outcome: 'bad_text', error: t.error };
  let r: RequestRow | undefined;
  let messageId: string;
  try {
    r = await readRequest(requestId);
    if (!r) return { outcome: 'not_found' };
    const { rows: [c] } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM stay_request_messages
        WHERE stay_request_id = $1::uuid AND author = 'guest' AND created_at > NOW() - INTERVAL '1 day'`,
      [requestId],
    );
    if ((c?.n ?? 0) >= STAY_CHAT_GUEST_DAILY_LIMIT) return { outcome: 'daily_limit' };
    messageId = await insertMessage(requestId, 'guest', door, t.text);
  } catch (err) {
    logFail('сообщение гостя не записано', err);
    return { outcome: 'save_failed' };
  }

  const facts = factsOf(r);
  let delivery: StayChatDelivery = 'no_address';
  let reason = 'у владельца нет подключённого MAX';
  if (r.owner_max_chat_id || r.owner_telegram_chat_id) {
    const res = await sendPdAlert({
      text: ownerIncomingText(facts, r.guest_name, t.text),
      stub: ownerIncomingStub(facts),
      buttons: [{ text: STAY_CHAT_BUTTON.owner, payload: stayChatPressPayload('owner', r.id) }],
      to: { maxChatId: r.owner_max_chat_id, telegramChatId: r.owner_telegram_chat_id },
    });
    delivery = res.channel === 'max' ? 'max' : r.owner_max_chat_id ? 'failed' : 'no_address';
    reason = res.reason;
  }
  if (delivery !== 'max') {
    console.error(`[stay-chat] ${r.id}: сообщение гостя владельцу не доставлено (${delivery}) — передаю оператору платформы`);
    const admin = await sendPdAlert({
      text: platformIncomingText(facts, r.guest_name, t.text, reason),
      stub: platformIncomingStub(facts),
      buttons: [{ text: 'Заявки гостей', url: `${getPublicBaseUrl()}${STAY_REQUESTS_ADMIN_PATH}` }],
    });
    if (!admin.delivered) console.error(`[stay-chat] ${r.id}: и оператору не доставлено (${admin.channel}) — ${admin.reason}`);
  }
  await recordDelivery(messageId, delivery, reason);
  await crmEvent(r, 'guest', door, delivery);
  return { outcome: 'sent', delivery };
}

/** Ответ хозяина гостю: в MAX гостя, если он подключил бота, и всегда — на страницу заявки. */
export async function postOwnerMessage(requestId: string, rawBody: unknown): Promise<PostResult> {
  const t = normalizeChatText(rawBody);
  if (!t.ok) return { outcome: 'bad_text', error: t.error };
  let r: RequestRow | undefined;
  let messageId: string;
  try {
    r = await readRequest(requestId);
    if (!r) return { outcome: 'not_found' };
    messageId = await insertMessage(requestId, 'owner', 'max', t.text);
  } catch (err) {
    logFail('ответ владельца не записан', err);
    return { outcome: 'save_failed' };
  }

  let delivery: StayChatDelivery = 'no_address';
  let reason = 'гость не подключил MAX';
  if (r.guest_max_chat_id) {
    const res = await maxSendDm(r.guest_max_chat_id, guestIncomingText(factsOf(r), t.text), {
      buttons: [{ text: STAY_CHAT_BUTTON.guest, payload: stayChatPressPayload('guest', r.id) }],
    });
    delivery = res.ok ? 'max' : 'failed';
    reason = res.ok ? 'доставлено в MAX' : (res.error ?? 'MAX API error');
    if (!res.ok) console.error(`[stay-chat] ${r.id}: ответ владельца гостю не доставлен — ${reason}`);
  }
  await recordDelivery(messageId, delivery, reason);
  await crmEvent(r, 'owner', 'max', delivery);
  return { outcome: 'sent', delivery };
}

// ── Чат MAX: кнопка, ожидание, текст ─────────────────────────────────────────

export interface StayChatReply {
  text: string;
  buttons: PdAlertButton[];
}

function againButton(side: StayChatSide, requestId: string): PdAlertButton[] {
  return [{ text: STAY_CHAT_BUTTON[side], payload: stayChatPressPayload(side, requestId) }];
}

/** Вправе ли этот чат писать по заявке с этой стороны. */
function chatMayWrite(r: RequestRow, side: StayChatSide, chatId: number): boolean {
  const own = side === 'owner' ? r.owner_max_chat_id : r.guest_max_chat_id;
  return own !== null && own === String(chatId);
}

/**
 * Кнопка «Ответить гостю» / «Написать владельцу»: проверить право чата и
 * завести ожидание. Новое ожидание гасит прежнее этого чата (одно живое —
 * индекс в 1348).
 */
export async function armStayChatWait(side: StayChatSide, requestId: string, chatId: number): Promise<StayChatReply> {
  let r: RequestRow | undefined;
  try {
    r = await readRequest(requestId);
  } catch (err) {
    logFail('заявка для кнопки не прочитана', err);
    return { text: STAY_CHAT_TEXT.unchecked, buttons: [] };
  }
  if (!r) return { text: STAY_CHAT_TEXT.notFound, buttons: [] };
  if (!chatMayWrite(r, side, chatId)) {
    return { text: side === 'owner' ? STAY_CHAT_TEXT.notYoursOwner : STAY_CHAT_TEXT.notYoursGuest, buttons: [] };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE stay_chat_waits SET status = 'superseded'
        WHERE channel = 'max' AND chat_id = $1::bigint AND status = 'waiting'`,
      [String(chatId)],
    );
    await client.query(
      `INSERT INTO stay_chat_waits (channel, chat_id, stay_request_id, side, expires_at)
       VALUES ('max', $1::bigint, $2::uuid, $3, NOW() + make_interval(mins => $4::int))`,
      [String(chatId), requestId, side, STAY_CHAT_WAIT_MIN],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    logFail('ожидание сообщения не заведено', err);
    return { text: STAY_CHAT_TEXT.unchecked, buttons: [] };
  } finally {
    client.release();
  }
  return { text: waitPrompt(side, factsOf(r)), buttons: [] };
}

/**
 * Текст личного диалога: если этот чат ждёт сообщение по заявке — отправить
 * его второй стороне и вернуть ответ; не ждёт — null, и сообщение идёт своим
 * путём (кабинет, Кузьмич). «Не смог проверить» — тоже null и SQLSTATE в лог:
 * отправить вслепую нельзя, а потерять сообщение хуже, чем отдать его
 * обычному пути.
 */
export async function captureStayChatText(chatId: number, text: string): Promise<StayChatReply | null> {
  // Команда бота и кнопка меню кабинета («Входящие», «Помощь») — не сообщение
  // гостю: они идут своим путём, ожидание остаётся. «/cancel» — отмена ниже.
  if ((text.trim().startsWith('/') && !isCancelText(text)) || roleMenuAsk(text) !== null) return null;
  let wait: { id: string; stay_request_id: string; side: StayChatSide } | undefined;
  try {
    ({ rows: [wait] } = await pool.query<{ id: string; stay_request_id: string; side: StayChatSide }>(
      `SELECT id::text AS id, stay_request_id::text AS stay_request_id, side
         FROM stay_chat_waits
        WHERE channel = 'max' AND chat_id = $1::bigint AND status = 'waiting' AND expires_at > NOW()`,
      [String(chatId)],
    ));
  } catch (err) {
    logFail('ждёт ли чат сообщение по заявке', err);
    return null;
  }
  if (!wait) return null;

  if (isCancelText(text)) {
    try {
      await pool.query(`UPDATE stay_chat_waits SET status = 'cancelled' WHERE id = $1::uuid AND status = 'waiting'`, [wait.id]);
    } catch (err) {
      logFail('ожидание не погашено', err);
      return { text: STAY_CHAT_TEXT.unchecked, buttons: [] };
    }
    return { text: STAY_CHAT_TEXT.cancelled, buttons: againButton(wait.side, wait.stay_request_id) };
  }

  // Длину судим до захвата ожидания: сократить и прислать снова можно, не нажимая кнопку.
  const t = normalizeChatText(text);
  if (!t.ok) return { text: `${t.error}. Ничего не отправлено.`, buttons: [] };

  try {
    const upd = await pool.query(
      `UPDATE stay_chat_waits SET status = 'used', used_at = NOW()
        WHERE id = $1::uuid AND status = 'waiting' AND expires_at > NOW()`,
      [wait.id],
    );
    if (upd.rowCount !== 1) return { text: STAY_CHAT_TEXT.expired, buttons: againButton(wait.side, wait.stay_request_id) };
  } catch (err) {
    logFail('ожидание не захвачено', err);
    return { text: STAY_CHAT_TEXT.unchecked, buttons: [] };
  }

  // Право чата — заново: между кнопкой и текстом чат могли перепривязать.
  let r: RequestRow | undefined;
  try {
    r = await readRequest(wait.stay_request_id);
  } catch (err) {
    logFail('заявка для отправки не прочитана', err);
    return { text: STAY_CHAT_TEXT.unchecked, buttons: againButton(wait.side, wait.stay_request_id) };
  }
  if (!r) return { text: STAY_CHAT_TEXT.notFound, buttons: [] };
  if (!chatMayWrite(r, wait.side, chatId)) {
    return { text: wait.side === 'owner' ? STAY_CHAT_TEXT.notYoursOwner : STAY_CHAT_TEXT.notYoursGuest, buttons: [] };
  }

  const res = wait.side === 'owner'
    ? await postOwnerMessage(r.id, t.text)
    : await postGuestMessage(r.id, t.text, 'max');
  if (res.outcome === 'sent') {
    return { text: sentReplyText(wait.side, res.delivery), buttons: againButton(wait.side, r.id) };
  }
  if (res.outcome === 'daily_limit') return { text: STAY_CHAT_TEXT.dailyLimit, buttons: [] };
  if (res.outcome === 'bad_text') return { text: `${res.error ?? 'Сообщение не принято'}. Ничего не отправлено.`, buttons: [] };
  if (res.outcome === 'not_found') return { text: STAY_CHAT_TEXT.notFound, buttons: [] };
  return { text: STAY_CHAT_TEXT.saveFailed, buttons: againButton(wait.side, r.id) };
}

// ── Подключение чата гостя ───────────────────────────────────────────────────

export const STAY_CHAT_BIND_SQL = `
  UPDATE stay_requests s
     SET guest_max_chat_id = $2::bigint,
         guest_chat_bound_at = COALESCE(s.guest_chat_bound_at, NOW())
    FROM agent_request_keys k
   WHERE k.key_hash = $1 AND k.expires_at > NOW() AND s.id = k.stay_request_id
     AND (s.guest_max_chat_id IS NULL OR s.guest_max_chat_id = $2::bigint)
  RETURNING s.id::text AS id`;

/**
 * «Старт» гостя по ссылке `sq_<ключ>`: подключить его чат к заявке и
 * прислать то, что владелец уже написал. Чужой чат не перезаписывается:
 * узнавший ключ иначе забрал бы переписку себе.
 */
export async function bindGuestChat(rawKey: string, chatId: number): Promise<StayChatReply[]> {
  const hash = keyHash(rawKey);
  if (!hash) return [{ text: STAY_CHAT_TEXT.bindNotFound, buttons: [] }];
  let id: string | undefined;
  try {
    ({ rows: [{ id } = { id: undefined }] } = await pool.query<{ id: string }>(STAY_CHAT_BIND_SQL, [hash, String(chatId)]));
    if (!id) {
      const { rows } = await pool.query(STAY_CHAT_KEY_SQL, [hash]);
      return [{ text: rows.length > 0 ? STAY_CHAT_TEXT.bindAlreadyBound : STAY_CHAT_TEXT.bindNotFound, buttons: [] }];
    }
  } catch (err) {
    logFail('чат гостя не подключён', err);
    return [{ text: STAY_CHAT_TEXT.bindDbError, buttons: [] }];
  }
  let r: RequestRow | undefined;
  let owner: { body: string }[] = [];
  try {
    r = await readRequest(id);
    owner = (await pool.query<{ body: string }>(
      `SELECT body FROM (
         SELECT body, created_at, id FROM stay_request_messages
          WHERE stay_request_id = $1::uuid AND author = 'owner'
          ORDER BY created_at DESC, id DESC LIMIT 5
       ) m ORDER BY created_at, id`,
      [id],
    )).rows;
  } catch (err) {
    logFail('переписка для подключённого чата не прочитана', err);
  }
  if (!r) return [{ text: 'Чат подключён: ответы владельца будут приходить сюда.', buttons: againButton('guest', id) }];
  const facts = factsOf(r);
  return [
    { text: guestBoundText(facts, owner.length), buttons: owner.length ? [] : againButton('guest', id) },
    ...owner.map((m, i) => ({
      text: guestIncomingText(facts, m.body),
      buttons: i === owner.length - 1 ? againButton('guest', id) : [],
    })),
  ];
}
