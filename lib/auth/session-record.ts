/**
 * Запись строки сессии в `user_sessions` — одна форма на все двери входа.
 *
 * Строка сессии — не аудит, а УСЛОВИЕ входа: `getUserFromRequest`
 * (lib/auth/jwt.ts) пропускает токен, только если `isSessionActive` находит
 * его в `user_sessions` (P1, аудит 28.08). Токен без строки мёртв на первом
 * же запросе к API.
 *
 * Регистрация (`/api/auth/register`) выдавала токен и cookie, а строку не
 * писала — человек, только что создавший аккаунт, получал 401 на всё до
 * повторного входа (аудит кабинета оператора, пакет «Г», пункт 1). Задело
 * все роли, не только оператора. Правка — не ещё одна копия INSERT, а эта
 * функция: вход и регистрация пишут строку одинаково, и срок сессии совпадает
 * со сроком самого JWT (`JWT_EXPIRATION` = 7d в lib/auth/jwt.ts).
 *
 * Сторож: `tests/unit/register-session.test.ts`.
 */

/** Срок жизни сессии в днях — тот же, что у JWT и у cookie `auth_token`. */
export const SESSION_TTL_DAYS = 7;

/** Всё, что умеет выполнить параметризованный запрос: пул или клиент транзакции. */
export interface SessionQueryable {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
}

/**
 * Записать сессию для выданного токена.
 *
 * Отказ НЕ глушится: вызывающий обязан узнать, что токен выдавать нельзя.
 * В регистрации запись идёт внутри транзакции — не записалась сессия, не
 * создаётся и аккаунт, человек повторяет попытку, а не упирается в 409.
 */
export async function recordUserSession(
  db: SessionQueryable,
  userId: string,
  token: string,
  now: Date = new Date(),
): Promise<Date> {
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.query(
    `INSERT INTO user_sessions (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [userId, token, expiresAt],
  );
  return expiresAt;
}
