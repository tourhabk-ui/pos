/**
 * Ссылка входа на сайт из Telegram-бота (команда /login).
 *
 * Правила (22.11):
 *  - срок — 5 минут (`MAGIC_LINK_TTL_SEC`);
 *  - ссылка одноразовая: у токена свой id (`jti`), при входе он погашается
 *    одной вставкой в `magic_link_redemptions` (миграция 1496) — повтор той же
 *    ссылки входа не даёт;
 *  - не выдаётся и не принимается для роли admin и для учётных записей с
 *    включённой двухфакторной проверкой: им — обычный вход на сайте, ссылка
 *    не должна обходить второй фактор.
 * Туристам, операторам и гидам ссылка нужна (вход в планер из чата).
 */
import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

export const MAGIC_LINK_TTL_SEC = 5 * 60;

export interface MagicUser {
  id: string;
  role: string;
  mfa_enabled?: boolean | null;
}

/** Можно ли этой учётной записи входить по ссылке из бота. */
export function magicLinkAllowed(user: Pick<MagicUser, 'role' | 'mfa_enabled'>): boolean {
  if (user.role === 'admin') return false;
  if (user.mfa_enabled === true) return false;
  return true;
}

export const MAGIC_LINK_REFUSED_TEXT =
  'Для этой учётной записи вход по ссылке из бота выключен. Войдите на сайте обычным способом: https://vedarai.ru/auth/login';

function magicSecret(env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const s = env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not set');
  return new TextEncoder().encode('magic:' + s);
}

/** Подписать одноразовую ссылку: userId + случайный jti, срок 5 минут. */
export async function signMagicToken(userId: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${MAGIC_LINK_TTL_SEC}s`)
    .sign(magicSecret(env));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Проверить подпись и срок. Без jti (ссылки старого вида) — отказ. */
export async function readMagicToken(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ userId: string; jti: string } | null> {
  try {
    const { payload } = await jwtVerify(token, magicSecret(env), { algorithms: ['HS256'], maxTokenAge: `${MAGIC_LINK_TTL_SEC}s` });
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    const jti = typeof payload.jti === 'string' && UUID_RE.test(payload.jti) ? payload.jti : null;
    return userId && jti ? { userId, jti } : null;
  } catch {
    return null;
  }
}

export interface MagicQueryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

/**
 * Погасить ссылку. Атомарно: из двух одновременных входов по одной ссылке
 * вставку делает ровно один, второй получает false.
 */
export async function redeemMagicJti(db: MagicQueryable, jti: string, userId: string): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO magic_link_redemptions (jti, user_id) VALUES ($1, $2)
     ON CONFLICT (jti) DO NOTHING
     RETURNING jti`,
    [jti, userId],
  );
  // Уборка старых отметок: ссылка живёт 5 минут, сутки — с запасом.
  void db.query(`DELETE FROM magic_link_redemptions WHERE redeemed_at < NOW() - INTERVAL '1 day'`).catch(() => {});
  return res.rows.length === 1;
}
