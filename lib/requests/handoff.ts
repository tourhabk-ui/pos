/**
 * Сквозная заявка между каналами (02.11; владелец: «письмо потом кодь»).
 *
 * Тот, кто держит ключ заявки (ссылка /request-status#KEY — это и есть
 * доказательство владения), получает вместе со статусом одноразовый код
 * вида ABCD-EFGH. Отправив код в другом канале (MAX, Telegram, чат сайта),
 * человек видит ту же заявку: краткую сводку без ПД и новую ссылку статуса.
 *
 * - код: 8 знаков из 31-символьного алфавита (~40 бит, crypto), в базе хеш;
 * - одноразовый: гасится атомарным UPDATE … WHERE used_at IS NULL;
 * - живёт 30 минут; не больше 3 живых кодов на ключ;
 * - предъявление ограничено по чату/IP (5 попыток за 10 минут) и глобально;
 * - новый ключ — только статусный (opensChat=false): переписку код не открывает;
 * - имя и телефон не переносятся никогда — Telegram их не видит (pd-guard).
 */
import { createHash, randomInt } from 'node:crypto';
import { pool } from '@/lib/db-pool';
import { createRateLimiter } from '@/lib/rate-limit';

export const HANDOFF_TTL_MIN = 30;
export const HANDOFF_MAX_LIVE_PER_KEY = 3;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ2345679'; // без 0/O, 1/I, 8/B-путаницы
const CODE_RE = new RegExp(`^(?:(?:код|code|代码)\\s*:?\\s*)?([${ALPHABET}]{4})-?([${ALPHABET}]{4})$`, 'i');

export type HandoffChannel = 'max' | 'telegram' | 'web';

const perChat = createRateLimiter({ windowMs: 10 * 60_000, max: 5 });
const global = createRateLimiter({ windowMs: 10 * 60_000, max: 200 });

function sha256(v: string): string { return createHash('sha256').update(v, 'utf8').digest('hex'); }

export function generateHandoffCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Код из реплики: «ABCD-EFGH», «код abcd efgh» не берём — только целиком. */
export function extractHandoffCode(text: string): string | null {
  const m = CODE_RE.exec(text.trim());
  if (!m) return null;
  const code = `${m[1]}-${m[2]}`.toUpperCase();
  // Обычное слово из 8 латинских букв без цифр и без дефиса — не код.
  if (!text.includes('-') && !/\d/.test(code)) return null;
  return code;
}

/** Выдать код на ключ заявки (по хешу сырого ключа). null — не выдан (лимит, нет ключа, сбой). */
export async function issueHandoffCode(rawKey: string): Promise<string | null> {
  const code = generateHandoffCode();
  try {
    const { rows } = await pool.query<{ ok: boolean }>(
      `WITH k AS (
         SELECT id FROM agent_request_keys WHERE key_hash = $1 AND expires_at > NOW()
       ), live AS (
         SELECT COUNT(*) AS n FROM request_handoff_codes c, k
          WHERE c.request_key_id = k.id AND c.used_at IS NULL AND c.expires_at > NOW()
       )
       INSERT INTO request_handoff_codes (code_hash, request_key_id, expires_at)
       SELECT $2, k.id, NOW() + ($3::int * INTERVAL '1 minute') FROM k, live WHERE live.n < $4
       RETURNING TRUE AS ok`,
      [sha256(rawKey), sha256(code), HANDOFF_TTL_MIN, HANDOFF_MAX_LIVE_PER_KEY],
    );
    return rows[0]?.ok ? code : null;
  } catch (err) {
    console.warn('[handoff] код не выдан', err instanceof Error ? err.message : err);
    return null;
  }
}

export function handoffLine(code: string | null): string {
  return code
    ? `Продолжить в другом канале (MAX, Telegram, чат сайта): отправьте там код ${code} — одноразовый, действует ${HANDOFF_TTL_MIN} мин.`
    : '';
}

export type RedeemResult =
  | { ok: true; key: string }
  | { ok: false; reason: 'rate_limited' | 'invalid' | 'error' };

/**
 * Предъявить код. `who` — id чата или IP: по нему лимит попыток.
 * Успех — новый статусный ключ той же заявки.
 */
export async function redeemHandoffCode(code: string, channel: HandoffChannel, who: string): Promise<RedeemResult> {
  if (!perChat.check(`${channel}:${who}`) || !global.check('all')) return { ok: false, reason: 'rate_limited' };
  try {
    const { rows } = await pool.query<{ lead_id: string | null; seat_request_id: string | null; stay_request_id: string | null }>(
      `WITH used AS (
         UPDATE request_handoff_codes SET used_at = NOW(), used_channel = $2
          WHERE code_hash = $1 AND used_at IS NULL AND expires_at > NOW()
          RETURNING request_key_id
       )
       SELECT k.lead_id::text, k.seat_request_id::text, k.stay_request_id::text
         FROM used JOIN agent_request_keys k ON k.id = used.request_key_id
        WHERE k.expires_at > NOW()`,
      [sha256(code.toUpperCase()), channel],
    );
    const r = rows[0];
    if (!r) return { ok: false, reason: 'invalid' };
    const { issueRequestKey } = await import('@/lib/mcp/request-status');
    const target = r.lead_id ? { leadId: r.lead_id } : r.seat_request_id ? { seatRequestId: r.seat_request_id } : r.stay_request_id ? { stayRequestId: r.stay_request_id } : null;
    if (!target) return { ok: false, reason: 'invalid' };
    const key = await issueRequestKey(target, `handoff:${channel}`, { opensChat: false });
    return key ? { ok: true, key } : { ok: false, reason: 'error' };
  } catch (err) {
    console.warn('[handoff] код не предъявлен', err instanceof Error ? err.message : err);
    return { ok: false, reason: 'error' };
  }
}

export const HANDOFF_INVALID_REPLY = 'Код не подошёл: он одноразовый и живёт 30 минут. Откройте ссылку заявки и возьмите новый код.';
export const HANDOFF_LIMIT_REPLY = 'Слишком много попыток ввести код. Подождите 10 минут.';
export const HANDOFF_ERROR_REPLY = 'Код сейчас не проверился. Повторите через минуту или откройте ссылку заявки.';

/** Ответ на код: сводка заявки без ПД (тот же текст, что статус по ссылке). */
export async function handoffReply(
  code: string, channel: HandoffChannel, who: string,
  /** `link: false` — чат не MAX и не Telegram (WhatsApp, Meta): связи 1416 нет. */
  opts: { link?: boolean } = {},
): Promise<string> {
  const res = await redeemHandoffCode(code, channel, who);
  if (!res.ok) return res.reason === 'rate_limited' ? HANDOFF_LIMIT_REPLY : res.reason === 'invalid' ? HANDOFF_INVALID_REPLY : HANDOFF_ERROR_REPLY;
  // Код предъявлен в этом чате — заявка в его «Моей поездке» (#2970, 1416).
  if (channel !== 'web' && opts.link !== false) {
    const { linkChatToKeys } = await import('@/lib/requests/chat-links');
    await linkChatToKeys(channel, who, [res.key], 'handoff');
  }
  const { requestStatusReply } = await import('@/lib/kuzmich/code-first');
  return `Заявка найдена в этом канале.\n${await requestStatusReply(res.key, { withHandoff: false })}`;
}
