/**
 * Администратор в MAX: одноразовая ссылка подключения и опознание на каждом
 * сообщении.
 *
 * Слово владельца 23.10: «Я админ и чат должен знать что админ подключен со
 * всеми правами»; способ — «1а»: кнопка «Подключить MAX администратора» в
 * админке (app/api/admin/max-link), ссылка на 10 минут, «Старт» в MAX.
 *
 * Привязан человек MAX (`user_id` заверенного апдейта), а не чат: в личном
 * диалоге id чата и id человека — разные числа, и права решает, кто пишет.
 * Права не кешируются: каждое сообщение заново читает, владеет ли аккаунт
 * ролью администратора — тем же предикатом, что перепись
 * /api/cron/admin-owners-census (активная роль или собственные роли). Снятый
 * в админке админ теряет и чат на следующем же сообщении.
 *
 * Ссылка — случайный ключ, в базе только его sha256 (как сброс пароля, 1175);
 * срок и одноразовость — предикаты UPDATE при погашении. Ключ не пишется в
 * лог ни целиком, ни частью.
 *
 * Почему не users.max_user_id — шапка миграции 1324.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { maxBot } from '@/lib/partners/channel-link';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

export const ADMIN_LINK_PREFIX = 'adm_';
export const ADMIN_LINK_TTL_MS = 10 * 60 * 1000;
/** 24 байта → 32 знака base64url: ссылка старта короче лимита MAX в 128 знаков. */
const TOKEN_BYTES = 24;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

type Exec = Pick<PoolClient, 'query'>;

/** Владеет ли аккаунт ролью администратора: активная роль или собственные роли. */
export function ownsAdminSql(alias: string): string {
  return `(${alias}.role = 'admin' OR (jsonb_typeof(${alias}.preferences->'roles') = 'array' AND (${alias}.preferences->'roles') ? 'admin'))`;
}

export function hashAdminLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Ключ из ссылки старта. null — это не ссылка администратора (разбирают
 * другие); 'malformed' — префикс наш, а ключ не той формы.
 */
export function adminTokenFromStart(arg: string): string | 'malformed' | null {
  if (!arg.startsWith(ADMIN_LINK_PREFIX)) return null;
  const token = arg.slice(ADMIN_LINK_PREFIX.length);
  return TOKEN_RE.test(token) ? token : 'malformed';
}

export type IssueAdminLink =
  | { ok: true; link: string; expiresAt: Date }
  | { ok: false; reason: 'not_admin' };

/**
 * Выдать ссылку. Прежние непогашенные ссылки того же администратора
 * отзываются тем же оператором; не администратор (роль снята, пока шёл
 * запрос) — ссылки нет. Отказ базы бросается: вызывающий отвечает 500.
 */
export async function issueAdminMaxLink(
  userId: string,
  exec: Exec = pool,
  now: Date = new Date(),
  randomSource: (n: number) => Buffer = randomBytes,
): Promise<IssueAdminLink> {
  const token = randomSource(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(now.getTime() + ADMIN_LINK_TTL_MS);
  const { rows } = await exec.query<{ id: string }>(
    `WITH owner AS (
       SELECT u.id FROM users u WHERE u.id = $1::uuid AND ${ownsAdminSql('u')}
     ), gone AS (
       DELETE FROM admin_max_link_tokens t USING owner
        WHERE t.user_id = owner.id AND t.used_at IS NULL
     )
     INSERT INTO admin_max_link_tokens (user_id, token_hash, expires_at)
     SELECT owner.id, $2::text, $3::timestamptz FROM owner
     RETURNING id::text AS id`,
    [userId, hashAdminLinkToken(token), expiresAt.toISOString()],
  );
  if (rows.length === 0) return { ok: false, reason: 'not_admin' };
  return { ok: true, link: `${maxBot()}?start=${ADMIN_LINK_PREFIX}${token}`, expiresAt };
}

export type ConsumeAdminLink =
  | { ok: true; userId: string; movedFromUserId: string | null }
  | { ok: false; reason: 'invalid' | 'used' | 'already_yours' | 'expired' | 'not_admin' };

/**
 * Погасить ссылку и привязать человека MAX — одной транзакцией на одном
 * соединении. Строка ключа берётся FOR UPDATE: второе нажатие той же ссылки
 * ждёт первое и видит used_at. Ссылка гасится и тогда, когда роль уже снята
 * (not_admin): повторно её не нажать. Человек MAX, привязанный к другому
 * администратору, переходит к выдавшему ссылку (movedFromUserId). Повторное
 * нажатие тем же человеком MAX, который по ней и подключён, — already_yours:
 * «подключали не вы» ему было бы неправдой.
 */
export async function consumeAdminMaxLink(token: string, maxUserId: number): Promise<ConsumeAdminLink> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<{ id: string; user_id: string; expired: boolean; used: boolean }>(
      `SELECT id::text AS id, user_id::text AS user_id,
              expires_at <= NOW() AS expired, used_at IS NOT NULL AS used
         FROM admin_max_link_tokens
        WHERE token_hash = $1
        FOR UPDATE`,
      [hashAdminLinkToken(token)],
    );
    const row = found.rows[0];
    if (!row) { await client.query('ROLLBACK'); return { ok: false, reason: 'invalid' }; }
    if (row.used) {
      const mine = await client.query(
        `SELECT 1 FROM admin_max_bindings WHERE user_id = $1::uuid AND max_user_id = $2::bigint`,
        [row.user_id, maxUserId],
      );
      await client.query('ROLLBACK');
      return { ok: false, reason: mine.rowCount === 1 ? 'already_yours' : 'used' };
    }
    if (row.expired) { await client.query('ROLLBACK'); return { ok: false, reason: 'expired' }; }

    const stamped = await client.query(
      `UPDATE admin_max_link_tokens SET used_at = NOW()
        WHERE id = $1::bigint AND used_at IS NULL AND expires_at > NOW()`,
      [row.id],
    );
    if (stamped.rowCount !== 1) { await client.query('ROLLBACK'); return { ok: false, reason: 'used' }; }

    const owner = await client.query(
      `SELECT 1 FROM users u WHERE u.id = $1::uuid AND ${ownsAdminSql('u')}`,
      [row.user_id],
    );
    if (owner.rowCount !== 1) {
      await client.query('COMMIT');
      return { ok: false, reason: 'not_admin' };
    }

    const moved = await client.query<{ user_id: string }>(
      `DELETE FROM admin_max_bindings
        WHERE max_user_id = $1::bigint AND user_id <> $2::uuid
        RETURNING user_id::text AS user_id`,
      [maxUserId, row.user_id],
    );
    await client.query(
      `INSERT INTO admin_max_bindings (user_id, max_user_id, bound_at)
       VALUES ($1::uuid, $2::bigint, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET max_user_id = EXCLUDED.max_user_id, bound_at = NOW()`,
      [row.user_id, maxUserId],
    );
    await client.query('COMMIT');
    return { ok: true, userId: row.user_id, movedFromUserId: moved.rows[0]?.user_id ?? null };
  } catch (err) {
    await client.query('ROLLBACK').catch((rbErr: unknown) => {
      logSwallowedFailure('max/admin', 'откат погашения ссылки', rbErr);
    });
    throw err;
  } finally {
    client.release();
  }
}

export type MaxAdminLookup =
  | { outcome: 'admin'; userId: string; name: string | null }
  | { outcome: 'none' }
  | { outcome: 'unavailable' };

/**
 * Администратор ли пишет: человек MAX привязан и его аккаунт сейчас владеет
 * ролью администратора. Три исхода (§4.0): «не смог проверить» не равно
 * «не администратор» — что с ним делать, решает вызывающий.
 */
export async function findMaxAdmin(maxUserId: number): Promise<MaxAdminLookup> {
  try {
    const { rows } = await pool.query<{ user_id: string; name: string | null }>(
      `SELECT b.user_id::text AS user_id, NULLIF(btrim(u.name), '') AS name
         FROM admin_max_bindings b
         JOIN users u ON u.id = b.user_id
        WHERE b.max_user_id = $1::bigint AND ${ownsAdminSql('u')}
        LIMIT 1`,
      [maxUserId],
    );
    const row = rows[0];
    return row ? { outcome: 'admin', userId: row.user_id, name: row.name } : { outcome: 'none' };
  } catch (err) {
    console.error('[max/admin] администратор не проверен, SQLSTATE', (err as { code?: string })?.code ?? 'нет SQLSTATE');
    return { outcome: 'unavailable' };
  }
}

/** boundAt — ISO 8601: текстовую форму PostgreSQL («… 10:00:00+00») Safari не разбирает. */
export interface AdminMaxStatus { bound: boolean; boundAt: string | null }

/** Подключён ли MAX у этого администратора — для админки. Отказ базы бросается. */
export async function adminMaxStatus(userId: string): Promise<AdminMaxStatus> {
  const { rows } = await pool.query<{ bound_at: Date }>(
    `SELECT bound_at FROM admin_max_bindings WHERE user_id = $1::uuid`,
    [userId],
  );
  return rows[0] ? { bound: true, boundAt: new Date(rows[0].bound_at).toISOString() } : { bound: false, boundAt: null };
}

/**
 * Отключить MAX администратора: привязку и выданные, но не погашенные ссылки
 * — «Отключить» не оставляет ни одной двери. true — привязка была. Отказ базы
 * бросается.
 */
export async function unbindAdminMax(userId: string): Promise<boolean> {
  const res = await pool.query(
    `WITH links AS (
       DELETE FROM admin_max_link_tokens WHERE user_id = $1::uuid AND used_at IS NULL
     )
     DELETE FROM admin_max_bindings WHERE user_id = $1::uuid`,
    [userId],
  );
  return (res.rowCount ?? 0) > 0;
}

export const ADMIN_MAX_TEXT = {
  bound: 'Готово: этот MAX подключён к Ведару как администратор. Права проверяются на каждом сообщении: '
    + 'снимут роль администратора на сайте — снимутся и здесь.',
  moved: 'Раньше этот MAX был подключён к другому аккаунту администратора — теперь к вашему.',
  invalid: 'Ссылка подключения администратора не найдена. Возьмите новую в админке: «Подключить MAX администратора».',
  malformed: 'Ссылка подключения администратора повреждена. Возьмите новую в админке.',
  used: 'Эта ссылка подключения уже использована. Если MAX подключали не вы — отключите его в админке и возьмите новую ссылку.',
  alreadyYours: 'Этот MAX уже подключён как администратор — по этой же ссылке. Делать ничего не нужно.',
  expired: 'Ссылка подключения устарела: она живёт 10 минут. Возьмите новую в админке.',
  notAdmin: 'Подключение не выполнено: у аккаунта, выдавшего ссылку, больше нет роли администратора.',
  noUser: 'Подключение не выполнено: MAX не сообщил, кто нажал «Старт». Откройте ссылку ещё раз из личного чата с ботом.',
  failed: 'Подключение не выполнено: база не ответила. Возьмите новую ссылку в админке чуть позже.',
  /** Кнопка rm:ad: — нажавший не администратор (или MAX не назвал, кто нажал). */
  deny: 'Эта кнопка — кабинет администратора. В этом чате её не выполняю.',
  /** Кнопка rm:ad: — база не ответила: роль не проверена, а не «не администратор». */
  unchecked: 'Роль администратора не проверена: база не ответила. Кнопку не выполняю.',
} as const;

/**
 * Ссылка старта `adm_` из ЗАВЕРЕННОГО апдейта bot_started. false — ссылка не
 * наша, разбирают другие. maxUserId — человек из апдейта, без отката на id
 * чата: привязывается человек.
 */
export async function handleAdminStart(
  arg: string,
  maxUserId: number | null,
  reply: (text: string) => Promise<void>,
): Promise<boolean> {
  const token = adminTokenFromStart(arg);
  if (token === null) return false;
  if (token === 'malformed') { await reply(ADMIN_MAX_TEXT.malformed); return true; }
  if (maxUserId === null) { await reply(ADMIN_MAX_TEXT.noUser); return true; }
  let res: ConsumeAdminLink;
  try {
    res = await consumeAdminMaxLink(token, maxUserId);
  } catch (err) {
    console.error('[max/admin] ссылка подключения не погашена, SQLSTATE', (err as { code?: string })?.code ?? 'нет SQLSTATE');
    await reply(ADMIN_MAX_TEXT.failed);
    return true;
  }
  if (!res.ok) {
    const text = { invalid: ADMIN_MAX_TEXT.invalid, used: ADMIN_MAX_TEXT.used, already_yours: ADMIN_MAX_TEXT.alreadyYours,
      expired: ADMIN_MAX_TEXT.expired, not_admin: ADMIN_MAX_TEXT.notAdmin }[res.reason];
    await reply(text);
    return true;
  }
  await reply(res.movedFromUserId ? `${ADMIN_MAX_TEXT.bound}\n\n${ADMIN_MAX_TEXT.moved}` : ADMIN_MAX_TEXT.bound);
  return true;
}
