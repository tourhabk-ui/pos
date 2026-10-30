/**
 * lib/requests/request-chat-service.ts — переписка адресата заявки и клиента:
 * запись, доставка второй стороне, ожидание сообщения после кнопки и
 * подключение чата MAX клиента. Правила и тексты — `lib/requests/request-chat.ts`.
 *
 * Заявка — одна из двух (1350): заявка на жильё хозяину (`stay_requests`,
 * 1206) или лид, адресованный партнёру (`leads.operator_id`): туроператору,
 * гиду, перевозчику, прокату. Лид без адресата ведёт менеджер Ведара —
 * переписки у него нет, и это сказано словами (`noCounterpart`).
 *
 * Двери три, правило одно:
 *   - чат MAX адресата — кнопка «Ответить гостю» / «Ответить клиенту» под
 *     заявкой, затем текст (`armChatWait` → `captureChatText`);
 *   - чат MAX клиента — «Старт» по ссылке со страницы заявки
 *     (`bindGuestChat`), кнопка «Написать …», затем текст;
 *   - страница заявки (`/request-status#<ключ>`) — `readRequestChat` и
 *     `postGuestMessage` по ключу статуса заявки (1238).
 *
 * Кто вправе:
 *   - адресат — чат, привязанный к его карточке партнёра (`partners.max_chat_id`);
 *     сверяется на кнопке и ещё раз при отправке: чат могли перепривязать;
 *   - клиент в MAX — чат, подключённый к заявке ключом (`guest_max_chat_id`);
 *   - клиент на странице — держатель ключа статуса. Ключ получили только
 *     человек и, если заявку оставил помощник через MCP или A2A, этот
 *     помощник; в ответы инструментов текст переписки не уходит
 *     (get_request_status отдаёт только число и время ответов).
 *
 * Исходы честные (§4.0): «не дошло» и «клиент не подключил MAX» — разные
 * значения в `delivery_channel`, отказ базы — SQLSTATE в лог и свой ответ,
 * а не «нет заявки». Сообщение клиента, не дошедшее до адресата, уходит
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
import { isWatchTrigger, looksLikeWatchText } from '@/lib/kuzmich/watch-flow';
import { leadPeopleSql } from '@/lib/leads/lead-people';
import {
  CHAT_TEXT, REASON_SUPERSEDED_NOTE, REQUEST_CHAT_GUEST_DAILY_LIMIT, REQUEST_CHAT_WAIT_MIN,
  chatButtonText, chatPressPayload, guestBoundText, guestIncomingText, isCancelText, leadDates, noPlaceToReadText,
  normalizeChatText, ownerIncomingStub, ownerIncomingText, ownerReplyButton, platformIncomingStub, platformIncomingText,
  roleOfCategory, sentReplyText, stayDates, waitPrompt,
  type ChatDelivery, type ChatFacts, type ChatSide, type ChatTarget,
} from '@/lib/requests/request-chat';

function logFail(where: string, err: unknown): void {
  const e = err as { message?: string; code?: string };
  console.error(`[request-chat] ${where}:`, e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
}

const KEY_RE = /^[A-Za-z0-9_-]+$/;

/** Ключ той формы, что выдаёт issueRequestKey; иначе null — в базу не ходим. */
function keyHash(raw: unknown): string | null {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key.length < REQUEST_KEY_MIN_CHARS || key.length > REQUEST_KEY_MAX_CHARS || !KEY_RE.test(key)) return null;
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Колонки цели в таблицах переписки: ровно одна не NULL (1350). */
function targetParams(t: ChatTarget): [string | null, string | null] {
  return t.kind === 'stay' ? [t.id, null] : [null, t.id];
}

// ── Заявка ───────────────────────────────────────────────────────────────────

interface ChatRow {
  target: ChatTarget;
  facts: ChatFacts;
  guestName: string;
  guestMaxChatId: string | null;
  partnerId: string | null;
  ownerMaxChatId: string | null;
  ownerTelegramChatId: string | null;
}

export const CHAT_STAY_SQL = `
  SELECT s.id::text AS id, a.name AS title,
         s.check_in_date::text AS check_in, s.check_out_date::text AS check_out, s.guests AS people,
         s.guest_name, s.guest_max_chat_id::text AS guest_max_chat_id,
         a.partner_id::text AS partner_id, p.name AS partner_name, p.category AS partner_category,
         p.max_chat_id::text AS owner_max_chat_id, p.telegram_chat_id::text AS owner_telegram_chat_id
    FROM stay_requests s
    JOIN accommodations a ON a.id = s.accommodation_id
    LEFT JOIN partners p ON p.id = a.partner_id
   WHERE s.id = $1::uuid`;

/**
 * Лид. Адресат — партнёр `operator_id`; у собственной пробы партнёра
 * (is_self, 1145) адресата для переписки нет: партнёр не переписывается сам с
 * собой, и проба его не будит. Число людей — только записанное
 * (`leadPeopleSql`): `group_size` не пишет никто, и «человек: 1» было бы
 * выдумкой (§4.0).
 */
export const CHAT_LEAD_SQL = `
  SELECT l.id::text AS id, COALESCE(NULLIF(btrim(l.route_title), ''), 'Заявка') AS title,
         l.desired_dates, ${leadPeopleSql('l')} AS people,
         l.name AS guest_name, l.guest_max_chat_id::text AS guest_max_chat_id,
         CASE WHEN l.is_self THEN NULL ELSE l.operator_id::text END AS partner_id,
         p.name AS partner_name, p.category AS partner_category,
         p.max_chat_id::text AS owner_max_chat_id, p.telegram_chat_id::text AS owner_telegram_chat_id
    FROM leads l
    LEFT JOIN partners p ON p.id = l.operator_id AND l.is_self = FALSE
   WHERE l.id = $1::uuid`;

interface RawRow {
  id: string;
  title: string;
  check_in?: string;
  check_out?: string;
  desired_dates?: string | null;
  people: number | null;
  guest_name: string;
  guest_max_chat_id: string | null;
  partner_id: string | null;
  partner_name: string | null;
  partner_category: string | null;
  owner_max_chat_id: string | null;
  owner_telegram_chat_id: string | null;
}

/** Строка заявки; undefined — нет такой. Бросает при отказе базы. */
async function readRow(target: ChatTarget): Promise<ChatRow | undefined> {
  const { rows: [r] } = await pool.query<RawRow>(target.kind === 'stay' ? CHAT_STAY_SQL : CHAT_LEAD_SQL, [target.id]);
  if (!r) return undefined;
  return {
    target,
    facts: {
      target: target.kind,
      title: r.title,
      dates: target.kind === 'stay' && r.check_in && r.check_out ? stayDates(r.check_in, r.check_out) : leadDates(r.desired_dates),
      people: r.people,
      counterpartName: r.partner_name,
      role: roleOfCategory(r.partner_category, target.kind),
    },
    guestName: r.guest_name,
    guestMaxChatId: r.guest_max_chat_id,
    partnerId: r.partner_id,
    ownerMaxChatId: r.owner_max_chat_id,
    ownerTelegramChatId: r.owner_telegram_chat_id,
  };
}

/**
 * Заявка по ключу статуса: только живой ключ. Переписку открывает лишь ключ,
 * выданный вместе с НОВОЙ заявкой (`opens_chat`, 1350): ключ повтора лида
 * получил бы и тот, кто знает чужой телефон, — ему только статус. Ключ
 * заявки на жильё открывает её всегда: склейки у жилья нет, а ключ, выданный
 * прежним кодом в окне выката, пришёл бы с FALSE по умолчанию.
 */
export const CHAT_KEY_SQL = `
  SELECT k.stay_request_id::text AS stay_id, k.lead_id::text AS lead_id,
         (k.opens_chat OR k.stay_request_id IS NOT NULL) AS opens_chat
    FROM agent_request_keys k
   WHERE k.key_hash = $1 AND k.expires_at > NOW()`;

/**
 * Есть ли у клиента живая ссылка на переписку: без неё и без MAX ответ
 * адресата прочитать негде, и кнопка «Ответить» это говорит, а не обещает.
 */
export const CHAT_LIVE_KEY_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM agent_request_keys k
     WHERE k.expires_at > NOW()
       AND (k.stay_request_id = $1::uuid OR (k.lead_id = $2::uuid AND k.opens_chat))
  ) AS live`;

/**
 * `status_only` — ключ живой и ведёт к заявке, но переписку не открывает
 * (ключ повтора, ключ инструмента без адресата); `no_chat` — ключ не заявки с
 * перепиской вовсе (запрос мест).
 */
type KeyTarget =
  | { outcome: 'chat'; target: ChatTarget }
  | { outcome: 'status_only'; target: ChatTarget }
  | { outcome: 'not_found' }
  | { outcome: 'no_chat' };

/** Бросает при отказе базы. */
async function targetOfHash(hash: string): Promise<KeyTarget> {
  const { rows: [k] } = await pool.query<{ stay_id: string | null; lead_id: string | null; opens_chat: boolean }>(CHAT_KEY_SQL, [hash]);
  if (!k) return { outcome: 'not_found' };
  const target: ChatTarget | null = k.stay_id ? { kind: 'stay', id: k.stay_id } : k.lead_id ? { kind: 'lead', id: k.lead_id } : null;
  if (!target) return { outcome: 'no_chat' };
  return k.opens_chat === true ? { outcome: 'chat', target } : { outcome: 'status_only', target };
}

// ── Страница заявки ──────────────────────────────────────────────────────────

export interface ChatMessageView {
  author: ChatSide;
  body: string;
  at: string;
}

/**
 * `no_chat` — ключ живой, но переписку не открывает (ключ повтора, запрос
 * мест); `no_counterpart` — у заявки нет адресата-партнёра: её ведёт менеджер
 * Ведара (или это своя проба), переписываться не с кем — так и при ключе,
 * который переписку открыл бы.
 */
export type ChatRead =
  | { outcome: 'ok'; facts: ChatFacts; guestBound: boolean; ownerOnMax: boolean; messages: ChatMessageView[] }
  | { outcome: 'bad_key' | 'not_found' | 'no_chat' | 'no_counterpart' | 'unavailable' };

/** Последние 200 сообщений по порядку: длинная переписка не прячет новые за старыми. */
export const CHAT_MESSAGES_SQL = `
  SELECT author, body, created_at FROM (
    SELECT author, body, created_at, id
      FROM request_messages
     WHERE stay_request_id = $1::uuid OR lead_id = $2::uuid
     ORDER BY created_at DESC, id DESC
     LIMIT 200
  ) m
   ORDER BY created_at, id`;

/**
 * Переписка для страницы заявки. Отдаётся автор, текст и время — без имени и
 * телефона клиента (человек их знает сам) и без адресов чатов.
 */
export async function readRequestChat(rawKey: unknown): Promise<ChatRead> {
  const hash = keyHash(rawKey);
  if (!hash) return { outcome: 'bad_key' };
  try {
    const k = await targetOfHash(hash);
    if (k.outcome === 'not_found' || k.outcome === 'no_chat') return { outcome: k.outcome };
    const r = await readRow(k.target);
    if (!r) return { outcome: 'not_found' };
    if (!r.partnerId) return { outcome: 'no_counterpart' };
    if (k.outcome === 'status_only') return { outcome: 'no_chat' };
    const { rows } = await pool.query<{ author: ChatSide; body: string; created_at: Date | string }>(
      CHAT_MESSAGES_SQL, targetParams(k.target),
    );
    return {
      outcome: 'ok',
      facts: r.facts,
      guestBound: r.guestMaxChatId !== null,
      ownerOnMax: r.ownerMaxChatId !== null,
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
export async function requestTargetByKey(rawKey: unknown): Promise<{ outcome: 'ok'; target: ChatTarget } | { outcome: 'bad_key' | 'not_found' | 'no_chat' | 'unavailable' }> {
  const hash = keyHash(rawKey);
  if (!hash) return { outcome: 'bad_key' };
  try {
    const k = await targetOfHash(hash);
    if (k.outcome === 'chat') return { outcome: 'ok', target: k.target };
    return { outcome: k.outcome === 'status_only' ? 'no_chat' : k.outcome };
  } catch (err) {
    logFail('ключ заявки не проверен', err);
    return { outcome: 'unavailable' };
  }
}

// ── Запись и доставка ────────────────────────────────────────────────────────

/**
 * `relayed` (сообщение клиента): не дошедшее до адресата получил оператор
 * Ведара; false — не получил и он. `pageVisible` (ответ адресата): у клиента
 * есть живая ссылка на переписку; false — прочитать ответ ему негде.
 */
export type PostResult =
  | { outcome: 'sent'; delivery: ChatDelivery; relayed?: boolean; pageVisible?: boolean }
  | { outcome: 'not_found' | 'no_counterpart' | 'daily_limit' | 'save_failed' | 'bad_text'; error?: string };

async function insertMessage(target: ChatTarget, author: ChatSide, door: 'max' | 'page', body: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO request_messages (stay_request_id, lead_id, author, door, body)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5)
     RETURNING id::text AS id`,
    [...targetParams(target), author, door, body],
  );
  return rows[0].id;
}

async function recordDelivery(messageId: string, delivery: ChatDelivery, reason: string): Promise<void> {
  try {
    await pool.query(
      `UPDATE request_messages SET delivery_channel = $2, delivery_reason = $3 WHERE id = $1::uuid`,
      [messageId, delivery, reason.slice(0, 300)],
    );
  } catch (err) {
    // Сообщение уже записано и отправлено: исход доставки — «не записан», а не «не дошло».
    logFail('исход доставки сообщения не записан', err);
  }
}

const EVENT_TITLE: Readonly<Record<ChatTarget['kind'], Record<ChatSide, string>>> = {
  stay: { guest: 'Заявка на жильё: сообщение гостя', owner: 'Заявка на жильё: ответ владельца в переписке' },
  lead: { guest: 'Заявка: сообщение клиента', owner: 'Заявка: ответ клиенту в переписке' },
};

function crmEvent(r: ChatRow, author: ChatSide, door: 'max' | 'page', delivery: ChatDelivery): Promise<void> {
  if (!r.partnerId) return Promise.resolve();
  return recordSourceEventQuietly({
    kind: author === 'guest' ? 'message_in' : 'message_out',
    sourceKind: r.target.kind === 'stay' ? 'stay_request' : 'lead',
    sourceId: r.target.id,
    actorKind: author === 'guest' ? 'tourist' : 'partner_user',
    title: EVENT_TITLE[r.target.kind][author],
    // Текст в ленту не пишется: свободный текст может нести что угодно.
    payload: { door, delivery },
  });
}

/** Где администратор видит заявку целиком. */
function adminPath(target: ChatTarget): string {
  return target.kind === 'stay' ? STAY_REQUESTS_ADMIN_PATH : '/hub/admin/leads';
}

/**
 * Есть ли у клиента живая ссылка на переписку. null — не смогли проверить:
 * тогда ничего не обещаем и не запрещаем, а SQLSTATE — в лог.
 */
async function clientHasLiveKey(target: ChatTarget): Promise<boolean | null> {
  try {
    const { rows: [k] } = await pool.query<{ live: boolean }>(CHAT_LIVE_KEY_SQL, targetParams(target));
    return k?.live === true;
  } catch (err) {
    logFail('есть ли у клиента ссылка на переписку', err);
    return null;
  }
}

function guestReplyButton(r: ChatRow): PdAlertButton {
  return { text: chatButtonText('guest', r.facts), payload: chatPressPayload('guest', r.target) };
}

/**
 * Сообщение клиента адресату. ПД (имя клиента) — только в MAX адресата; не
 * дошло — оператору платформы, он передаст. Сутки — не больше
 * `REQUEST_CHAT_GUEST_DAILY_LIMIT` сообщений по заявке.
 */
export async function postGuestMessage(target: ChatTarget, rawBody: unknown, door: 'max' | 'page'): Promise<PostResult> {
  const t = normalizeChatText(rawBody);
  if (!t.ok) return { outcome: 'bad_text', error: t.error };
  let r: ChatRow | undefined;
  let messageId: string;
  try {
    r = await readRow(target);
    if (!r) return { outcome: 'not_found' };
    if (!r.partnerId) return { outcome: 'no_counterpart' };
    const { rows: [c] } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM request_messages
        WHERE (stay_request_id = $1::uuid OR lead_id = $2::uuid)
          AND author = 'guest' AND created_at > NOW() - INTERVAL '1 day'`,
      targetParams(target),
    );
    if ((c?.n ?? 0) >= REQUEST_CHAT_GUEST_DAILY_LIMIT) return { outcome: 'daily_limit' };
    messageId = await insertMessage(target, 'guest', door, t.text);
  } catch (err) {
    logFail('сообщение клиента не записано', err);
    return { outcome: 'save_failed' };
  }

  let delivery: ChatDelivery = 'no_address';
  let reason = 'у адресата нет подключённого MAX';
  if (r.ownerMaxChatId || r.ownerTelegramChatId) {
    const res = await sendPdAlert({
      text: ownerIncomingText(r.facts, r.guestName, t.text),
      stub: ownerIncomingStub(r.facts),
      buttons: [ownerReplyButton(target)],
      to: { maxChatId: r.ownerMaxChatId, telegramChatId: r.ownerTelegramChatId },
    });
    delivery = res.channel === 'max' ? 'max' : r.ownerMaxChatId ? 'failed' : 'no_address';
    reason = res.reason;
  }
  let relayed: boolean | undefined;
  if (delivery !== 'max') {
    console.error(`[request-chat] ${target.kind}:${target.id}: сообщение клиента адресату не доставлено (${delivery}) — передаю оператору платформы`);
    const admin = await sendPdAlert({
      text: platformIncomingText(r.facts, r.guestName, t.text, reason),
      stub: platformIncomingStub(r.facts),
      buttons: [{ text: 'Заявки', url: `${getPublicBaseUrl()}${adminPath(target)}` }],
    });
    // Заглушка в Telegram — тоже «получил»: текст оператор найдёт у заявки в админке.
    relayed = admin.delivered;
    if (!admin.delivered) console.error(`[request-chat] ${target.kind}:${target.id}: и оператору не доставлено (${admin.channel}) — ${admin.reason}`);
  }
  await recordDelivery(messageId, delivery, reason);
  await crmEvent(r, 'guest', door, delivery);
  return relayed === undefined ? { outcome: 'sent', delivery } : { outcome: 'sent', delivery, relayed };
}

/** Ответ адресата клиенту: в MAX клиента, если он подключил бота, и всегда — на страницу заявки. */
export async function postOwnerMessage(target: ChatTarget, rawBody: unknown): Promise<PostResult> {
  const t = normalizeChatText(rawBody);
  if (!t.ok) return { outcome: 'bad_text', error: t.error };
  let r: ChatRow | undefined;
  let messageId: string;
  try {
    r = await readRow(target);
    if (!r) return { outcome: 'not_found' };
    if (!r.partnerId) return { outcome: 'no_counterpart' };
    messageId = await insertMessage(target, 'owner', 'max', t.text);
  } catch (err) {
    logFail('ответ адресата не записан', err);
    return { outcome: 'save_failed' };
  }

  let delivery: ChatDelivery = 'no_address';
  let reason = 'клиент не подключил MAX';
  if (r.guestMaxChatId) {
    const res = await maxSendDm(r.guestMaxChatId, guestIncomingText(r.facts, t.text), { buttons: [guestReplyButton(r)] });
    delivery = res.ok ? 'max' : 'failed';
    reason = res.ok ? 'доставлено в MAX' : (res.error ?? 'MAX API error');
    if (!res.ok) console.error(`[request-chat] ${target.kind}:${target.id}: ответ клиенту не доставлен — ${reason}`);
  }
  // Не дошло в MAX — прочитать можно только на странице заявки, если ссылка жива.
  const live = delivery === 'max' ? true : await clientHasLiveKey(target);
  if (live === false) reason = `${reason}; у клиента нет живой ссылки на переписку`;
  await recordDelivery(messageId, delivery, reason);
  await crmEvent(r, 'owner', 'max', delivery);
  return live === false ? { outcome: 'sent', delivery, pageVisible: false } : { outcome: 'sent', delivery };
}

// ── Чат MAX: кнопка, ожидание, текст ─────────────────────────────────────────

export interface ChatReply {
  text: string;
  buttons: PdAlertButton[];
}

function againButton(side: ChatSide, r: ChatRow): PdAlertButton[] {
  return [side === 'owner' ? ownerReplyButton(r.target) : guestReplyButton(r)];
}

/** Вправе ли этот чат писать по заявке с этой стороны. */
function chatMayWrite(r: ChatRow, side: ChatSide, chatId: number): boolean {
  const own = side === 'owner' ? r.ownerMaxChatId : r.guestMaxChatId;
  return own !== null && own === String(chatId);
}

function notYours(side: ChatSide): ChatReply {
  return { text: side === 'owner' ? CHAT_TEXT.notYoursOwner : CHAT_TEXT.notYoursGuest, buttons: [] };
}

/**
 * Кнопка «Ответить …» / «Написать …»: проверить право чата и завести
 * ожидание. Новое ожидание гасит прежнее этого чата (одно живое — индекс 1349).
 */
export async function armChatWait(side: ChatSide, target: ChatTarget, chatId: number): Promise<ChatReply> {
  let r: ChatRow | undefined;
  try {
    r = await readRow(target);
  } catch (err) {
    logFail('заявка для кнопки не прочитана', err);
    return { text: CHAT_TEXT.unchecked, buttons: [] };
  }
  if (!r) return { text: CHAT_TEXT.notFound, buttons: [] };
  if (!r.partnerId) return { text: CHAT_TEXT.noCounterpart, buttons: [] };
  if (!chatMayWrite(r, side, chatId)) return notYours(side);
  // Ответ, который клиенту прочитать негде, не обещается: без MAX клиента и
  // без живой ссылки на переписку кнопка говорит «позвоните».
  if (side === 'owner' && !r.guestMaxChatId && await clientHasLiveKey(target) === false) {
    return { text: noPlaceToReadText(r.facts), buttons: [] };
  }
  let reasonSuperseded = false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE request_chat_waits SET status = 'superseded'
        WHERE channel = 'max' AND chat_id = $1::bigint AND status = 'waiting'`,
      [String(chatId)],
    );
    // Последняя кнопка — главная: ожидание причины отказа брони в этом же чате
    // (lib/bookings/chat-owner-action) гаснет, иначе следующий текст после
    // переписки ушёл бы туристу причиной отказа.
    const reason = await client.query(
      `UPDATE partner_chat_actions SET status = 'superseded'
        WHERE channel = 'max' AND chat_id = $1::bigint AND status = 'awaiting_reason'`,
      [String(chatId)],
    );
    reasonSuperseded = (reason.rowCount ?? 0) > 0;
    await client.query(
      `INSERT INTO request_chat_waits (channel, chat_id, stay_request_id, lead_id, side, expires_at)
       VALUES ('max', $1::bigint, $2::uuid, $3::uuid, $4, NOW() + make_interval(mins => $5::int))`,
      [String(chatId), ...targetParams(target), side, REQUEST_CHAT_WAIT_MIN],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    // Два нажатия разом: второе упёрлось в «одно живое ожидание на чат»
    // (23505) — ожидание уже завела первая, и ответ тот же.
    if ((err as { code?: string })?.code === '23505') return { text: waitPrompt(side, r.facts), buttons: [] };
    logFail('ожидание сообщения не заведено', err);
    return { text: CHAT_TEXT.unchecked, buttons: [] };
  } finally {
    client.release();
  }
  const prompt = waitPrompt(side, r.facts);
  return { text: reasonSuperseded ? `${prompt}\n\n${REASON_SUPERSEDED_NOTE}` : prompt, buttons: [] };
}

/**
 * Текст личного диалога: если этот чат ждёт сообщение по заявке — отправить
 * его второй стороне и вернуть ответ; не ждёт — null, и сообщение идёт своим
 * путём (кабинет, Кузьмич). «Не смог проверить» — тоже null и SQLSTATE в лог:
 * отправить вслепую нельзя, а потерять сообщение хуже, чем отдать его
 * обычному пути.
 */
export async function captureChatText(chatId: number, text: string): Promise<ChatReply | null> {
  // Команда бота и кнопка меню кабинета («Входящие», «Помощь») — не сообщение
  // клиенту: они идут своим путём, ожидание остаётся. «/cancel» — отмена ниже.
  if ((text.trim().startsWith('/') && !isCancelText(text)) || roleMenuAsk(text) !== null) return null;
  type WaitRow = {
    id: string; stay_id: string | null; lead_id: string | null; side: ChatSide;
    reason_newer: boolean; watch_open: boolean;
  };
  let wait: WaitRow | undefined;
  try {
    // reason_newer — после этой кнопки в чате нажали «Отклонить» под бронью:
    // последняя кнопка главная, и текст — причина отказа, а не сообщение.
    // watch_open — из этого чата поставлен контроль выхода, и он открыт.
    ({ rows: [wait] } = await pool.query<WaitRow>(
      `SELECT w.id::text AS id, w.stay_request_id::text AS stay_id, w.lead_id::text AS lead_id, w.side,
              EXISTS (
                SELECT 1 FROM partner_chat_actions a
                 WHERE a.channel = 'max' AND a.chat_id = w.chat_id AND a.status = 'awaiting_reason'
                   AND a.expires_at > NOW() AND a.created_at > w.created_at
              ) AS reason_newer,
              EXISTS (
                SELECT 1 FROM route_registrations r
                 WHERE r.tourist_chat_channel = 'max' AND r.tourist_chat_id = w.chat_id AND r.completed_at IS NULL
              ) AS watch_open
         FROM request_chat_waits w
        WHERE w.channel = 'max' AND w.chat_id = $1::bigint AND w.status = 'waiting' AND w.expires_at > NOW()`,
      [String(chatId)],
    ));
  } catch (err) {
    logFail('ждёт ли чат сообщение по заявке', err);
    return null;
  }
  if (!wait) return null;
  // Контроль выхода и причина отказа после новой кнопки «Отклонить» — не
  // сообщение второй стороне: текст получает свой поток, а ожидание гаснет.
  // Контроль — это просьба поставить его («поставьте на контроль выхода»)
  // всегда и, пока контроль из этого чата открыт, его отметки («вернулся»,
  // «задерживаюсь», «+2 ч»): уйди «вернулся» гиду вместо контроля — и сторож
  // поднял бы ложную тревогу о невозвращении.
  const toWatch = isWatchTrigger(text) || (wait.watch_open && looksLikeWatchText(text));
  if (wait.reason_newer || toWatch) {
    try {
      await pool.query(`UPDATE request_chat_waits SET status = 'superseded' WHERE id = $1::uuid AND status = 'waiting'`, [wait.id]);
    } catch (err) {
      // Текст всё равно уходит своему потоку; ожидание само истечёт через REQUEST_CHAT_WAIT_MIN.
      logFail('ожидание не погашено перед другим потоком', err);
    }
    return null;
  }
  const target: ChatTarget = wait.stay_id ? { kind: 'stay', id: wait.stay_id } : { kind: 'lead', id: wait.lead_id ?? '' };

  // Строка заявки нужна и для кнопки «ещё раз», и для повторной проверки права.
  const reread = async (): Promise<ChatRow | undefined | 'failed'> => {
    try { return await readRow(target); } catch (err) { logFail('заявка для отправки не прочитана', err); return 'failed'; }
  };

  if (isCancelText(text)) {
    try {
      await pool.query(`UPDATE request_chat_waits SET status = 'cancelled' WHERE id = $1::uuid AND status = 'waiting'`, [wait.id]);
    } catch (err) {
      logFail('ожидание не погашено', err);
      return { text: CHAT_TEXT.unchecked, buttons: [] };
    }
    const r = await reread();
    return { text: CHAT_TEXT.cancelled, buttons: r && r !== 'failed' ? againButton(wait.side, r) : [] };
  }

  // Длину судим до захвата ожидания: сократить и прислать снова можно, не нажимая кнопку.
  const t = normalizeChatText(text);
  if (!t.ok) return { text: `${t.error}. Ничего не отправлено.`, buttons: [] };

  try {
    const upd = await pool.query(
      `UPDATE request_chat_waits SET status = 'used', used_at = NOW()
        WHERE id = $1::uuid AND status = 'waiting' AND expires_at > NOW()`,
      [wait.id],
    );
    if (upd.rowCount !== 1) {
      const r = await reread();
      return { text: CHAT_TEXT.expired, buttons: r && r !== 'failed' ? againButton(wait.side, r) : [] };
    }
  } catch (err) {
    logFail('ожидание не захвачено', err);
    return { text: CHAT_TEXT.unchecked, buttons: [] };
  }

  // Право чата — заново: между кнопкой и текстом чат могли перепривязать.
  const r = await reread();
  if (r === 'failed') return { text: CHAT_TEXT.unchecked, buttons: [] };
  if (!r) return { text: CHAT_TEXT.notFound, buttons: [] };
  if (!chatMayWrite(r, wait.side, chatId)) return notYours(wait.side);

  const res = wait.side === 'owner'
    ? await postOwnerMessage(target, t.text)
    : await postGuestMessage(target, t.text, 'max');
  switch (res.outcome) {
    case 'sent': return { text: sentReplyText(wait.side, res.delivery, r.facts, res), buttons: againButton(wait.side, r) };
    case 'daily_limit': return { text: CHAT_TEXT.dailyLimit, buttons: [] };
    case 'bad_text': return { text: `${res.error ?? 'Сообщение не принято'}. Ничего не отправлено.`, buttons: [] };
    case 'not_found': return { text: CHAT_TEXT.notFound, buttons: [] };
    case 'no_counterpart': return { text: CHAT_TEXT.noCounterpart, buttons: [] };
    default: return { text: CHAT_TEXT.saveFailed, buttons: againButton(wait.side, r) };
  }
}

// ── Подключение чата клиента ─────────────────────────────────────────────────

export const CHAT_BIND_STAY_SQL = `
  UPDATE stay_requests s
     SET guest_max_chat_id = $2::bigint,
         guest_chat_bound_at = COALESCE(s.guest_chat_bound_at, NOW())
    FROM agent_request_keys k
   WHERE k.key_hash = $1 AND k.expires_at > NOW() AND s.id = k.stay_request_id
     AND (s.guest_max_chat_id IS NULL OR s.guest_max_chat_id = $2::bigint)
  RETURNING s.id::text AS id`;

export const CHAT_BIND_LEAD_SQL = `
  UPDATE leads l
     SET guest_max_chat_id = $2::bigint,
         guest_chat_bound_at = COALESCE(l.guest_chat_bound_at, NOW())
    FROM agent_request_keys k
   WHERE k.key_hash = $1 AND k.expires_at > NOW() AND k.opens_chat AND l.id = k.lead_id
     AND (l.guest_max_chat_id IS NULL OR l.guest_max_chat_id = $2::bigint)
  RETURNING l.id::text AS id`;

/**
 * «Старт» клиента по ссылке `sq_<ключ>`: подключить его чат к заявке и
 * прислать то, что адресат уже написал. Чужой чат не перезаписывается:
 * узнавший ключ иначе забрал бы переписку себе.
 */
export async function bindGuestChat(rawKey: string, chatId: number): Promise<ChatReply[]> {
  const hash = keyHash(rawKey);
  if (!hash) return [{ text: CHAT_TEXT.bindNotFound, buttons: [] }];
  let r: ChatRow | undefined;
  try {
    const k = await targetOfHash(hash);
    if (k.outcome === 'not_found') return [{ text: CHAT_TEXT.bindNotFound, buttons: [] }];
    if (k.outcome === 'no_chat') return [{ text: CHAT_TEXT.bindNoChat, buttons: [] }];
    r = await readRow(k.target);
    if (!r) return [{ text: CHAT_TEXT.bindNotFound, buttons: [] }];
    if (!r.partnerId) return [{ text: CHAT_TEXT.noCounterpart, buttons: [] }];
    if (k.outcome === 'status_only') return [{ text: CHAT_TEXT.bindNoChat, buttons: [] }];
    const { rows } = await pool.query<{ id: string }>(
      k.target.kind === 'stay' ? CHAT_BIND_STAY_SQL : CHAT_BIND_LEAD_SQL, [hash, String(chatId)],
    );
    if (!rows[0]) return [{ text: CHAT_TEXT.bindAlreadyBound, buttons: [] }];
  } catch (err) {
    logFail('чат клиента не подключён', err);
    return [{ text: CHAT_TEXT.bindDbError, buttons: [] }];
  }
  let owner: { body: string }[] = [];
  try {
    owner = (await pool.query<{ body: string }>(
      `SELECT body FROM (
         SELECT body, created_at, id FROM request_messages
          WHERE (stay_request_id = $1::uuid OR lead_id = $2::uuid) AND author = 'owner'
          ORDER BY created_at DESC, id DESC LIMIT 5
       ) m ORDER BY created_at, id`,
      targetParams(r.target),
    )).rows;
  } catch (err) {
    // Чат подключён; не прочиталась только история — она есть на странице заявки.
    logFail('переписка для подключённого чата не прочитана', err);
  }
  const row = r;
  return [
    { text: guestBoundText(row.facts, owner.length), buttons: owner.length ? [] : againButton('guest', row) },
    ...owner.map((m, i) => ({
      text: guestIncomingText(row.facts, m.body),
      buttons: i === owner.length - 1 ? againButton('guest', row) : [],
    })),
  ];
}
