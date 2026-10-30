/**
 * lib/auth/max-login.ts
 *
 * Одноразовые сессии входа через MAX-бота. Поток:
 *   1) сайт создаёт nonce (createMaxLoginSession) и отдаёт deep-link в бота;
 *   2) пользователь жмёт «Старт» → бот закрепляет сессию за его MAX user_id
 *      (claimMaxLoginSession) и СПРАШИВАЕТ, он ли входит на сайт;
 *   3) «Да, это я» от того же пользователя → сессия подтверждена
 *      (confirmMaxLoginSession); «Нет» → сессия гаснет (rejectMaxLoginSession);
 *   4) сайт опрашивает статус и, увидев authenticated, обменивает nonce на
 *      аккаунт+JWT (consumeMaxLoginSession — атомарно, единожды).
 *
 * Шаг 3 появился после аудита 22.10. До него «Старт» сразу подтверждал вход,
 * а ссылку входа создаёт любой: злоумышленник начинал вход у себя в браузере,
 * присылал ссылку жертве («посмотри бота»), жертва жала «Старт» — и его
 * браузер получал вход в её аккаунт. Теперь бот называет, что происходит, и
 * без нажатия «Да» тем же человеком вход не выдаётся.
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
  /**
   * Истекла ли сессия — по часам БАЗЫ (`expires_at <= NOW()`), не Node.
   * «Нет, не я» гасит сессию записью `expires_at = NOW()` часами базы; читать
   * её часами приложения с усечением микросекунд (`new Date(text) < Date.now()`)
   * значило, что в той же миллисекунде сессия ещё «pending» (kernel-pg на main
   * f0408ac, 30.10). Запись и чтение судят одним и тем же временем.
   */
  expired: boolean;
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

/** Длина nonce, которую вообще есть смысл искать в базе. */
function plausibleNonce(nonce: string): boolean {
  return Boolean(nonce) && nonce.length >= 8 && nonce.length <= 128;
}

/**
 * Шаг 2: «Старт» в боте (bot_started с payload=login-<nonce>) закрепляет
 * сессию за пользователем MAX, но вход НЕ подтверждает. Закрепить можно
 * только живую pending-сессию, ещё ничью или уже свою (повторный «Старт»
 * того же человека). Чужую — нельзя: подтвердит её только тот, кто нажал
 * «Старт» первым.
 */
export async function claimMaxLoginSession(
  nonce: string,
  data: { maxUserId: number; name: string | null; username: string | null },
): Promise<boolean> {
  if (!plausibleNonce(nonce)) return false;
  const r = await query(
    `UPDATE max_login_sessions
        SET max_user_id = $2,
            max_name = $3,
            max_username = $4
      WHERE nonce = $1
        AND status = 'pending'
        AND consumed = FALSE
        AND expires_at > NOW()
        AND (max_user_id IS NULL OR max_user_id = $2)`,
    [nonce, data.maxUserId, data.name, data.username],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Шаг 3: «Да, это я» — подтверждает вход. Только тот же пользователь MAX,
 * за которым сессия закреплена на шаге 2, и только живую pending-сессию.
 */
export async function confirmMaxLoginSession(nonce: string, maxUserId: number): Promise<boolean> {
  if (!plausibleNonce(nonce)) return false;
  const r = await query(
    `UPDATE max_login_sessions
        SET status = 'authenticated',
            authenticated_at = NOW()
      WHERE nonce = $1
        AND status = 'pending'
        AND consumed = FALSE
        AND expires_at > NOW()
        AND max_user_id = $2`,
    [nonce, maxUserId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * «Нет, не я» — сессия гаснет сразу: браузер, начавший вход, получит
 * «истекла», а не вход. Погасить может только тот, за кем она закреплена.
 */
export async function rejectMaxLoginSession(nonce: string, maxUserId: number): Promise<boolean> {
  if (!plausibleNonce(nonce)) return false;
  const r = await query(
    `UPDATE max_login_sessions
        SET expires_at = NOW()
      WHERE nonce = $1
        AND status = 'pending'
        AND consumed = FALSE
        AND expires_at > NOW()
        AND max_user_id = $2`,
    [nonce, maxUserId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Прочитать статус сессии (без побочных эффектов). */
export async function getMaxLoginSession(nonce: string): Promise<MaxLoginSession | null> {
  const r = await query<MaxLoginSession>(
    `SELECT status, max_user_id::text, max_name, max_username, consumed, expires_at::text,
            (expires_at <= NOW()) AS expired
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
