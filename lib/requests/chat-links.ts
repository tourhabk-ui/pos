/**
 * lib/requests/chat-links.ts
 *
 * Связь «чат мессенджера ↔ заявка» (#2970, миграция 1416). На ней стоит
 * «Моя поездка»: какие заявки показать в ЭТОМ чате MAX или Telegram.
 *
 * Связь пишет только тот, кто ключ заявки ПОЛУЧИЛ или ПРЕДЪЯВИЛ в этом чате:
 *  - created     — заявку создал Кузьмич в этом чате (ключи из итога вызова);
 *  - sq          — открыта ссылка переписки по заявке (MAX);
 *  - handoff     — погашен одноразовый код между каналами;
 *  - status_link — человек вставил ссылку или ключ статуса.
 * По телефону и имени связь не ищется и не пишется: номер в тексте не
 * доказывает, что заявка его.
 *
 * Запись — best-effort: заявка уже принята, и отказ связи не должен портить
 * ответ человеку. Но отказ не глушится (§4.0): имя операции и SQLSTATE в лог.
 */
import { createHash } from 'node:crypto';
import { pool } from '@/lib/db-pool';
import { logText } from '@/lib/log/log-text';

export type LinkChannel = 'max' | 'telegram';
export type LinkOrigin = 'created' | 'sq' | 'handoff' | 'status_link';

/** Сколько заявок чата читает «Моя поездка»: свежие первыми. */
export const CHAT_LINKS_LIMIT = 10;

function sha256(v: string): string {
  return createHash('sha256').update(v, 'utf8').digest('hex');
}

/** id чата в текст: пустой или слишком длинный — не пишем (CHECK 1416). */
function chatKey(chatId: string | number): string | null {
  const s = String(chatId).trim();
  return s && s.length <= 64 ? s : null;
}

/**
 * Связь по СЫРЫМ ключам заявок. Ключ, которого нет или который истёк, связи
 * не даёт: строка пишется только из живой строки `agent_request_keys`.
 * Возвращает число новых связей; `null` — запись не удалась (в логе причина).
 */
export const LINK_BY_KEYS_SQL = `
  INSERT INTO chat_request_links (channel, chat_id, key_id, origin)
  SELECT $1, $2, k.id, $4
    FROM agent_request_keys k
   WHERE k.key_hash = ANY($3::text[]) AND k.expires_at > NOW()
  ON CONFLICT (channel, chat_id, key_id) DO NOTHING`;

export async function linkChatToKeys(
  channel: LinkChannel, chatId: string | number, rawKeys: readonly (string | null | undefined)[], origin: LinkOrigin,
): Promise<number | null> {
  const chat = chatKey(chatId);
  const hashes = [...new Set(rawKeys.filter((k): k is string => typeof k === 'string' && k.length > 0))].map(sha256);
  if (!chat || hashes.length === 0) return 0;
  try {
    const r = await pool.query(LINK_BY_KEYS_SQL, [channel, chat, hashes, origin]);
    return r.rowCount ?? 0;
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[chat-links] связь чата с заявкой не записана:', origin,
      typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    return null;
  }
}

/**
 * Номера живых ключей заявок этого чата, свежие первыми. `'failed'` — база
 * не ответила: это не «заявок нет» (§4.0).
 */
export const CHAT_KEY_IDS_SQL = `
  SELECT l.key_id::text AS key_id
    FROM chat_request_links l
    JOIN agent_request_keys k ON k.id = l.key_id
   WHERE l.channel = $1 AND l.chat_id = $2 AND k.expires_at > NOW()
   ORDER BY l.created_at DESC
   LIMIT $3`;

export async function chatLinkedKeyIds(channel: LinkChannel, chatId: string | number, limit = CHAT_LINKS_LIMIT): Promise<string[] | 'failed'> {
  const chat = chatKey(chatId);
  if (!chat) return [];
  try {
    const { rows } = await pool.query<{ key_id: string }>(CHAT_KEY_IDS_SQL, [channel, chat, limit]);
    return rows.map((r) => r.key_id);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[chat-links] заявки чата не прочитались:',
      typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    return 'failed';
  }
}

/** Есть ли у чата хоть одна живая заявка — для кнопки «Моя поездка» (слово владельца: после первой заявки). */
export async function chatHasRequests(channel: LinkChannel, chatId: string | number): Promise<boolean | 'failed'> {
  const ids = await chatLinkedKeyIds(channel, chatId, 1);
  return ids === 'failed' ? 'failed' : ids.length > 0;
}

/** Ключи заявок из структурного итога пишущего инструмента (`structured.requests[].status_key`). */
export function issuedKeysOf(structured: unknown): string[] {
  if (!structured || typeof structured !== 'object') return [];
  const requests = (structured as { requests?: unknown }).requests;
  if (!Array.isArray(requests)) return [];
  return requests
    .map((r) => (r && typeof r === 'object' ? (r as { status_key?: unknown }).status_key : null))
    .filter((k): k is string => typeof k === 'string' && k.length > 0);
}

/** Канал записи чата Кузьмича (`max` / `tg` / `web`) → канал связи; веб связи не даёт. */
export function linkChannelOf(channel: string): LinkChannel | null {
  return channel === 'max' ? 'max' : channel === 'tg' || channel === 'telegram' ? 'telegram' : null;
}
