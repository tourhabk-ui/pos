/**
 * lib/auth/max-login.ts
 *
 * Одноразовые сессии входа через MAX-бота. Поток:
 *   1) сайт создаёт nonce (createMaxLoginSession) и отдаёт deep-link в бота;
 *   2) пользователь жмёт «Старт» → бот подтверждает nonce
 *      (authenticateMaxLoginSession) своим MAX user_id;
 *   3) сайт опрашивает статус и, увидев authenticated, обменивает nonce на
 *      аккаунт+JWT (consumeMaxLoginSession — атомарно, единожды).
 *
 * Телефон на входе не требуем (решение владельца): идентификация по max_user_id.
 */

import { randomBytes } from 'crypto';
import { query } from '@/lib/database';

/** Время жизни nonce — коротко: это одноразовый вход, а не долгая сессия. */
export const MAX_LOGIN_TTL_MS = 5 * 60 * 1000;

export interface MaxLoginSession {
  status: 'pending' | 'authenticated';
  max_user_id: string | null;
  max_name: string | null;
  max_username: string | null;
  consumed: boolean;
  expires_at: string;
}

/** Создать одноразовую сессию входа. Возвращает nonce для deep-link. */
export async function createMaxLoginSession(): Promise<{ nonce: string; expiresAt: Date }> {
  const nonce = randomBytes(24).toString('base64url'); // ~32 симв., секретный
  const expiresAt = new Date(Date.now() + MAX_LOGIN_TTL_MS);
  await query(
    `INSERT INTO max_login_sessions (nonce, status, expires_at) VALUES ($1, 'pending', $2)`,
    [nonce, expiresAt],
  );
  return { nonce, expiresAt };
}

/**
 * Подтвердить сессию из бота (bot_started с payload=login-<nonce>).
 * Возвращает true, если сессия существовала, была pending и не истекла.
 * Идемпотентно по времени: истёкшую/чужую/использованную не трогает.
 */
export async function authenticateMaxLoginSession(
  nonce: string,
  data: { maxUserId: number; name: string | null; username: string | null },
): Promise<boolean> {
  if (!nonce || nonce.length < 8 || nonce.length > 128) return false;
  const r = await query(
    `UPDATE max_login_sessions
        SET status = 'authenticated',
            max_user_id = $2,
            max_name = $3,
            max_username = $4,
            authenticated_at = NOW()
      WHERE nonce = $1
        AND status = 'pending'
        AND consumed = FALSE
        AND expires_at > NOW()`,
    [nonce, data.maxUserId, data.name, data.username],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Прочитать статус сессии (без побочных эффектов). */
export async function getMaxLoginSession(nonce: string): Promise<MaxLoginSession | null> {
  const r = await query<MaxLoginSession>(
    `SELECT status, max_user_id::text, max_name, max_username, consumed, expires_at::text
       FROM max_login_sessions WHERE nonce = $1`,
    [nonce],
  );
  return r.rows[0] ?? null;
}

/**
 * Атомарно «погасить» подтверждённую сессию — единожды. Возвращает данные MAX,
 * если сессия была authenticated, не истекла и ещё не использована; иначе null.
 * Защита от повторной выдачи JWT по одному nonce.
 */
export async function consumeMaxLoginSession(
  nonce: string,
): Promise<{ maxUserId: number; name: string | null; username: string | null } | null> {
  const r = await query<{ max_user_id: string; max_name: string | null; max_username: string | null }>(
    `UPDATE max_login_sessions
        SET consumed = TRUE
      WHERE nonce = $1
        AND status = 'authenticated'
        AND consumed = FALSE
        AND expires_at > NOW()
      RETURNING max_user_id::text, max_name, max_username`,
    [nonce],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    maxUserId: parseInt(row.max_user_id, 10),
    name: row.max_name,
    username: row.max_username,
  };
}
