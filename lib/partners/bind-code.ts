/**
 * Короткий код «/start ABC123» из кабинета оператора.
 *
 * Пишет чат в карточку партнёра (bindPartnerChannel), не в users.telegram_id.
 * Поэтому администратор в «Войти как» не получает командный центр:
 * роль человека в users здесь не читается.
 *
 * Шесть знаков без 0/O и 1/I. Срок — 30 минут. Новый код гасит прежний
 * неиспользованный. Один код можно потратить отдельно в Telegram и в MAX.
 */

import { randomInt } from 'crypto';
import { pool } from '@/lib/db-pool';
import { getPublicBaseUrl } from '@/lib/config';
import { maxBot, telegramBot } from '@/lib/partners/channel-link';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const BIND_CODE_TTL_MS = 30 * 60 * 1000;
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

export function normalizeBindCode(raw: string): string | null {
  const code = raw.trim().toUpperCase().replace(/\s+/g, '');
  return CODE_RE.test(code) ? code : null;
}

export function mintBindCode(): string {
  let out = '';
  for (let i = 0; i < 6; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export type IssuedBindCode = {
  code: string;
  expiresAt: Date;
  telegramUrl: string;
  maxUrl: string;
};

export async function issueBindCode(partnerId: string, now: number = Date.now()): Promise<IssuedBindCode | null> {
  const expiresAt = new Date(now + BIND_CODE_TTL_MS);
  await pool.query(
    `UPDATE messenger_bind_codes
        SET expires_at = NOW()
      WHERE partner_id = $1::uuid
        AND expires_at > NOW()
        AND telegram_chat_id IS NULL
        AND max_chat_id IS NULL`,
    [partnerId],
  );
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = mintBindCode();
    try {
      await pool.query(
        `INSERT INTO messenger_bind_codes (code, partner_id, expires_at)
         VALUES ($1, $2::uuid, $3)`,
        [code, partnerId, expiresAt.toISOString()],
      );
      const start = code;
      return {
        code,
        expiresAt,
        telegramUrl: `https://t.me/${telegramBot()}?start=${start}`,
        maxUrl: `${maxBot()}?start=${start}`,
      };
    } catch (err) {
      const sqlState = (err as { code?: string }).code;
      if (sqlState === '23505') continue;
      console.error('[bind-code] код не записан, SQLSTATE', sqlState ?? 'нет SQLSTATE');
      return null;
    }
  }
  console.error('[bind-code] не удалось подобрать свободный код');
  return null;
}

export type ConsumedBindCode =
  | { ok: true; partnerId: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' | 'db_error' };

/** Погасить код для одного канала. Неизвестный, просроченный и уже потраченный — разные причины в лог, один текст человеку. */
export async function consumeBindCode(
  raw: string,
  channel: 'telegram' | 'max',
  chatId: number,
): Promise<ConsumedBindCode> {
  const code = normalizeBindCode(raw);
  if (!code || !Number.isSafeInteger(chatId)) return { ok: false, reason: 'unknown' };
  const column = channel === 'telegram' ? 'telegram_chat_id' : 'max_chat_id';
  try {
    const { rows } = await pool.query<{ partner_id: string; expires_at: Date; taken: string | null }>(
      `SELECT partner_id::text, expires_at, ${column}::text AS taken
         FROM messenger_bind_codes
        WHERE code = $1`,
      [code],
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: 'unknown' };
    if (row.taken) return { ok: false, reason: 'used' };
    if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' };
    const updated = await pool.query(
      `UPDATE messenger_bind_codes
          SET ${column} = $2
        WHERE code = $1
          AND ${column} IS NULL
          AND expires_at > NOW()`,
      [code, String(chatId)],
    );
    if ((updated.rowCount ?? 0) !== 1) return { ok: false, reason: 'used' };
    return { ok: true, partnerId: row.partner_id };
  } catch (err) {
    console.error('[bind-code] код не погашен, SQLSTATE', (err as { code?: string }).code ?? 'нет SQLSTATE');
    return { ok: false, reason: 'db_error' };
  }
}

export function bindCodeMissedText(): string {
  return 'Код не подошёл — нажмите «Получить новый».';
}

export function bindCodeRenewUrl(): string {
  return `${getPublicBaseUrl().replace(/\/$/, '')}/hub/operator/profile`;
}
