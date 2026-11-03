/**
 * Ответ туристу в обычном чате Ведара (conversations) прямо из мессенджера
 * партнёра (план CRM в мессенджере, п.2; как #2960 для заявок):
 *   «Ответить» под уведомлением → текст → предпросмотр → «Отправить».
 *
 * Правила:
 *  - писать может только партнёр-участник беседы (оператор или гид) из СВОЕГО
 *    MAX или Telegram (адрес — reachForPartner, как у уведомления);
 *  - туристу ничего не уходит до подписанного «Отправить»; отправка ровно одна
 *    (draft → used одним UPDATE);
 *  - в Telegram предпросмотр показывает текст с маской ПД; туристу текст
 *    уходит как написан (в чат на сайте, через chatService.sendMessage);
 *  - одно живое ожидание на чат: новая кнопка гасит прежнее, в том числе
 *    ожидание ответа по заявке (request_chat_waits) — последняя кнопка главная.
 */
import { pool } from '@/lib/db-pool';
import { ROLE_TO_CATEGORY } from '@/lib/crm/partner-context';
import { INBOX_CHAT_CATEGORIES } from '@/lib/crm/inbox-kinds';
import { reachForPartner } from '@/lib/partners/reach';
import { redactPII, redactChatPD } from '@/lib/security/pii-redact';
import { escapeHtml } from '@/lib/text/escape-html';
import { signPayload } from '@/lib/chat-cabinet/signed-payload';

export type ConvChannel = 'max' | 'telegram';
export interface ConvReply { text: string; buttons: Array<{ text: string; payload: string }> }

export const CONV_WAIT_MIN = 15;
export const CONV_MAX_LEN = 2000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PRESS_RE = new RegExp(`^cv:([rsx]):(${UUID})$`, 'i');

export const CONV_TEXT = {
  prompt: 'Напишите ответ туристу одним сообщением. Сначала покажу, как он выглядит, — отправка только по «Отправить». Передумали — «отмена».',
  notYours: 'Эта беседа не ваша или чат не привязан к вашей карточке. Ничего не отправлено.',
  notFound: 'Беседа не найдена. Ничего не отправлено.',
  unchecked: 'База не ответила. Ничего не отправлено — попробуйте ещё раз.',
  expired: 'Время на ответ вышло. Ничего не отправлено — нажмите «Ответить» ещё раз.',
  cancelled: 'Не отправил. Чтобы ответить, нажмите «Ответить» ещё раз.',
  gone: 'Этот черновик уже отправлен, отменён или устарел. Ничего не отправил — нажмите «Ответить» ещё раз.',
  empty: 'Пустое сообщение. Ничего не отправлено.',
  tooLong: `Сообщение длиннее ${CONV_MAX_LEN} знаков — сократите и пришлите снова. Ничего не отправлено.`,
  sent: 'Отправил туристу в чат Ведара — он увидит ответ на сайте.',
  saveFailed: 'Сообщение не сохранилось. Ничего не отправлено — попробуйте ещё раз.',
} as const;

const CANCEL_RE = /^(\/cancel|отмена|отменить|не надо|не отправляй|стоп)[.!]?$/i;

export function convPayload(action: 'reply' | 'send' | 'cancel', id: string): string {
  return `cv:${action === 'reply' ? 'r' : action === 'send' ? 's' : 'x'}:${id.toLowerCase()}`;
}
export function isConvPayload(payload: string): boolean {
  return payload.startsWith('cv:');
}
export function parseConvPress(payload: string): { action: 'reply' | 'send' | 'cancel'; id: string } | null {
  const m = PRESS_RE.exec(payload);
  if (!m) return null;
  const a = m[1].toLowerCase();
  return { action: a === 'r' ? 'reply' : a === 's' ? 'send' : 'cancel', id: m[2].toLowerCase() };
}

/** Кнопка под уведомлением о сообщении туриста. Запись не делает — без подписи. */
export function convReplyButton(conversationId: string): { text: string; payload: string } {
  return { text: 'Ответить', payload: convPayload('reply', conversationId) };
}

/** Текст для Telegram: телефоны, почта, ссылки, @ники и имена (где узнаются) скрыты. */
export function maskConvText(body: string, names: ReadonlyArray<string | null | undefined> = []): string {
  return redactChatPD(body, names);
}

export function convPreviewText(body: string, channel: ConvChannel): string {
  const shown = channel === 'telegram' ? maskConvText(body) : body;
  return [
    '<b>Проверьте ответ туристу</b> в чате Ведара',
    '',
    escapeHtml(shown),
    '',
    channel === 'telegram' && shown !== body
      ? 'Телефоны и почта здесь скрыты, турист получит текст как вы его написали. Отправить?'
      : 'Отправить?',
  ].join('\n');
}

function logFail(what: string, err: unknown): void {
  console.error(`[conv-reply] ${what}, SQLSTATE`, (err as { code?: string })?.code ?? 'нет SQLSTATE');
}

interface Side { partnerId: string; userId: string }

/** Партнёрская сторона беседы один на один, если этот чат — её мессенджер. */
async function partnerSideForChat(conversationId: string, chatId: number, channel: ConvChannel): Promise<Side | 'not_found' | 'not_yours'> {
  const { rows } = await pool.query<{ user_id: string; role: string }>(
    `SELECT user_id::text AS user_id, role FROM conversation_participants WHERE conversation_id = $1::uuid`,
    [conversationId],
  );
  if (rows.length !== 2) return 'not_found';
  const side = rows.find((r) => {
    const c = ROLE_TO_CATEGORY[r.role];
    return c !== undefined && INBOX_CHAT_CATEGORIES.has(c);
  });
  if (!side) return 'not_yours';
  const category = ROLE_TO_CATEGORY[side.role];
  const partner = (await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM partners WHERE user_id = $1::uuid AND category = $2
      ORDER BY created_at ASC NULLS LAST, id ASC LIMIT 1`,
    [side.user_id, category],
  )).rows[0];
  if (!partner) return 'not_yours';
  const reach = await reachForPartner(partner.id);
  if (reach === null) throw new Error('адрес партнёра не прочитался');
  const own = channel === 'telegram' ? reach.telegramChatId : reach.maxChatId;
  if (own === null || String(own) !== String(chatId)) return 'not_yours';
  return { partnerId: partner.id, userId: side.user_id };
}

/** «Ответить»: проверить право чата и завести ожидание текста. */
export async function armConvReply(conversationId: string, chatId: number, channel: ConvChannel): Promise<ConvReply> {
  let side: Side | 'not_found' | 'not_yours';
  try {
    side = await partnerSideForChat(conversationId, chatId, channel);
  } catch (err) {
    logFail('право чата не проверено', err);
    return { text: CONV_TEXT.unchecked, buttons: [] };
  }
  if (side === 'not_found') return { text: CONV_TEXT.notFound, buttons: [] };
  if (side === 'not_yours') return { text: CONV_TEXT.notYours, buttons: [] };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE conversation_reply_waits SET status = 'superseded'
        WHERE channel = $1 AND chat_id = $2::bigint AND status IN ('waiting', 'draft')`,
      [channel, String(chatId)],
    );
    await client.query(
      `UPDATE request_chat_waits SET status = 'superseded'
        WHERE channel = $1 AND chat_id = $2::bigint AND status IN ('waiting', 'draft')`,
      [channel, String(chatId)],
    );
    await client.query(
      `INSERT INTO conversation_reply_waits (channel, chat_id, conversation_id, partner_id, sender_user_id, expires_at)
       VALUES ($1, $2::bigint, $3::uuid, $4::uuid, $5::uuid, NOW() + make_interval(mins => $6::int))`,
      [channel, String(chatId), conversationId, side.partnerId, side.userId, CONV_WAIT_MIN],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((err as { code?: string })?.code === '23505') return { text: CONV_TEXT.prompt, buttons: [] };
    logFail('ожидание не заведено', err);
    return { text: CONV_TEXT.unchecked, buttons: [] };
  } finally {
    client.release();
  }
  return { text: CONV_TEXT.prompt, buttons: [] };
}

/**
 * Текст личного диалога: ждёт ли чат ответа в беседе — черновик и
 * предпросмотр; не ждёт (или база не ответила) — null, текст идёт своим путём.
 */
export async function captureConvText(chatId: number, text: string, channel: ConvChannel): Promise<ConvReply | null> {
  if (text.trim().startsWith('/') && !CANCEL_RE.test(text.trim())) return null;
  let wait: { id: string; conversation_id: string } | undefined;
  try {
    ({ rows: [wait] } = await pool.query<{ id: string; conversation_id: string }>(
      `SELECT id::text AS id, conversation_id::text AS conversation_id FROM conversation_reply_waits
        WHERE channel = $1 AND chat_id = $2::bigint AND status = 'waiting' AND expires_at > NOW()`,
      [channel, String(chatId)],
    ));
  } catch (err) {
    logFail('ждёт ли чат ответа в беседе', err);
    return null;
  }
  if (!wait) return null;
  const again = [convReplyButton(wait.conversation_id)];
  if (CANCEL_RE.test(text.trim())) {
    try {
      await pool.query(`UPDATE conversation_reply_waits SET status = 'cancelled' WHERE id = $1::uuid AND status = 'waiting'`, [wait.id]);
    } catch (err) {
      logFail('ожидание не погашено', err);
      return { text: CONV_TEXT.unchecked, buttons: [] };
    }
    return { text: CONV_TEXT.cancelled, buttons: again };
  }
  const body = text.trim();
  if (!body) return { text: CONV_TEXT.empty, buttons: [] };
  if (body.length > CONV_MAX_LEN) return { text: CONV_TEXT.tooLong, buttons: [] };
  try {
    const upd = await pool.query(
      `UPDATE conversation_reply_waits
          SET status = 'draft', draft_text = $2, expires_at = NOW() + make_interval(mins => $3::int)
        WHERE id = $1::uuid AND status = 'waiting' AND expires_at > NOW()`,
      [wait.id, body, CONV_WAIT_MIN],
    );
    if (upd.rowCount !== 1) return { text: CONV_TEXT.expired, buttons: again };
  } catch (err) {
    logFail('черновик не записан', err);
    return { text: CONV_TEXT.unchecked, buttons: [] };
  }
  return {
    text: convPreviewText(body, channel),
    buttons: [
      { text: 'Отправить', payload: signPayload(convPayload('send', wait.id)) },
      { text: 'Отменить', payload: convPayload('cancel', wait.id) },
    ],
  };
}

/** Нажатие кнопки cv:… (подпись уже снята вызывающим). */
export async function pressConv(payload: string, chatId: number, channel: ConvChannel): Promise<ConvReply> {
  const press = parseConvPress(payload);
  if (!press) return { text: 'Кнопка не распознана — ничего не отправлено.', buttons: [] };
  if (press.action === 'reply') return armConvReply(press.id, chatId, channel);
  type Row = { conversation_id: string; draft_text: string | null; sender_user_id: string };
  let row: Row | undefined;
  try {
    const sql = press.action === 'send'
      ? `UPDATE conversation_reply_waits SET status = 'used', used_at = NOW()
          WHERE id = $1::uuid AND channel = $2 AND chat_id = $3::bigint AND status = 'draft' AND expires_at > NOW()
          RETURNING conversation_id::text AS conversation_id, draft_text, sender_user_id::text AS sender_user_id`
      : `UPDATE conversation_reply_waits SET status = 'cancelled'
          WHERE id = $1::uuid AND channel = $2 AND chat_id = $3::bigint AND status = 'draft'
          RETURNING conversation_id::text AS conversation_id, draft_text, sender_user_id::text AS sender_user_id`;
    ({ rows: [row] } = await pool.query<Row>(sql, [press.id, channel, String(chatId)]));
  } catch (err) {
    logFail('черновик не захвачен', err);
    return { text: CONV_TEXT.unchecked, buttons: [] };
  }
  if (!row) return { text: CONV_TEXT.gone, buttons: [] };
  const again = [convReplyButton(row.conversation_id)];
  if (press.action === 'cancel') return { text: CONV_TEXT.cancelled, buttons: again };
  // Право чата — заново: между кнопкой и «Отправить» чат могли перепривязать.
  let side: Side | 'not_found' | 'not_yours';
  try {
    side = await partnerSideForChat(row.conversation_id, chatId, channel);
  } catch (err) {
    logFail('право чата перед отправкой не проверено', err);
    return { text: CONV_TEXT.unchecked, buttons: [] };
  }
  if (side === 'not_found') return { text: CONV_TEXT.notFound, buttons: [] };
  if (side === 'not_yours' || side.userId !== row.sender_user_id) return { text: CONV_TEXT.notYours, buttons: [] };
  try {
    const { chatService } = await import('@/lib/services/operators/chat.service');
    await chatService.sendMessage({ conversationId: row.conversation_id, senderId: side.userId, content: row.draft_text ?? '' });
  } catch (err) {
    logFail('сообщение не сохранено', err);
    return { text: CONV_TEXT.saveFailed, buttons: again };
  }
  return { text: CONV_TEXT.sent, buttons: again };
}
