/**
 * Администратор в Telegram: одноразовая ссылка подключения и опознание на
 * каждом сообщении.
 *
 * Слово владельца 24.10: «нет привязки админа к Telegram». Способ — тот же,
 * что у MAX (23.10, «1а»): кнопка в админке, ссылка на 10 минут, «Старт».
 *
 * Привязан человек Telegram (`from.id` личного чата), а не чат. Права не
 * кешируются: каждое сообщение заново читает `ownsAdminSql` — тот же
 * предикат, что у MAX и у переписи /api/cron/admin-owners-census. Снятый
 * в админке админ теряет и чат на следующем же сообщении.
 *
 * Префикс `adt_`, не `adm_`: ссылка MAX, вставленная в Telegram, здесь не
 * гасится, и наоборот. Ключ в базе — только sha256. В лог не пишется.
 *
 * Почему не users.telegram_id — шапка миграции 1330.
 */

import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { hashAdminLinkToken, ownsAdminSql, ADMIN_LINK_TTL_MS } from '@/lib/max/admin-link';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

export const TELEGRAM_ADMIN_LINK_PREFIX = 'adt_';
export { ADMIN_LINK_TTL_MS };
/** 24 байта → 32 знака base64url. `adt_` + ключ = 36: лимит параметра start в Telegram — 64. */
const TOKEN_BYTES = 24;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const BOT_NAME_RE = /^[A-Za-z0-9_]{5,32}$/;

type Exec = Pick<PoolClient, 'query'>;
type Connector = () => Promise<Pick<PoolClient, 'query' | 'release'>>;

/**
 * Ключ из ссылки старта. null — это не ссылка администратора Telegram
 * (разбирают другие, в том числе `adm_` MAX); 'malformed' — префикс наш,
 * а ключ не той формы.
 */
export function adminTelegramTokenFromStart(arg: string): string | 'malformed' | null {
  if (!arg.startsWith(TELEGRAM_ADMIN_LINK_PREFIX)) return null;
  const token = arg.slice(TELEGRAM_ADMIN_LINK_PREFIX.length);
  return TOKEN_RE.test(token) ? token : 'malformed';
}

export function telegramAdminStartLink(botUsername: string, token: string): string {
  return `https://t.me/${botUsername}?start=${TELEGRAM_ADMIN_LINK_PREFIX}${token}`;
}

export type IssueAdminTelegramLink =
  | { ok: true; link: string; expiresAt: Date }
  | { ok: false; reason: 'not_admin' | 'bot_name' };

/**
 * Выдать ссылку. Прежние непогашенные ссылки того же администратора
 * отзываются; не администратор — ссылки нет. Имя бота обязано быть
 * username: иначе deep link собрался бы на чужой адрес. Отказ базы бросается.
 */
export async function issueAdminTelegramLink(
  userId: string,
  botUsername: string,
  exec: Exec = pool,
  now: Date = new Date(),
  randomSource: (n: number) => Buffer = randomBytes,
): Promise<IssueAdminTelegramLink> {
  if (!BOT_NAME_RE.test(botUsername)) return { ok: false, reason: 'bot_name' };
  const token = randomSource(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(now.getTime() + ADMIN_LINK_TTL_MS);
  const { rows } = await exec.query<{ id: string }>(
    `WITH owner AS (
       SELECT u.id FROM users u WHERE u.id = $1::uuid AND ${ownsAdminSql('u')}
     ), gone AS (
       DELETE FROM admin_tg_link_tokens t USING owner
        WHERE t.user_id = owner.id AND t.used_at IS NULL
     )
     INSERT INTO admin_tg_link_tokens (user_id, token_hash, expires_at)
     SELECT owner.id, $2::text, $3::timestamptz FROM owner
     RETURNING id::text AS id`,
    [userId, hashAdminLinkToken(token), expiresAt.toISOString()],
  );
  if (rows.length === 0) return { ok: false, reason: 'not_admin' };
  return { ok: true, link: telegramAdminStartLink(botUsername, token), expiresAt };
}

export type ConsumeAdminTelegramLink =
  | { ok: true; userId: string; movedFromUserId: string | null }
  | { ok: false; reason: 'invalid' | 'used' | 'already_yours' | 'expired' | 'not_admin' };

/**
 * Погасить ссылку и привязать человека Telegram — одной транзакцией.
 * Строка ключа берётся FOR UPDATE. Ссылка гасится и тогда, когда роль уже
 * снята. Человек, привязанный к другому администратору, переходит к
 * выдавшему ссылку. Повтор тем же человеком — already_yours.
 */
export async function consumeAdminTelegramLink(
  token: string,
  telegramUserId: number,
  connect: Connector = () => pool.connect(),
): Promise<ConsumeAdminTelegramLink> {
  if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) {
    return { ok: false, reason: 'invalid' };
  }
  const client = await connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<{ id: string; user_id: string; expired: boolean; used: boolean }>(
      `SELECT id::text AS id, user_id::text AS user_id,
              expires_at <= NOW() AS expired, used_at IS NOT NULL AS used
         FROM admin_tg_link_tokens
        WHERE token_hash = $1
        FOR UPDATE`,
      [hashAdminLinkToken(token)],
    );
    const row = found.rows[0];
    if (!row) { await client.query('ROLLBACK'); return { ok: false, reason: 'invalid' }; }
    if (row.used) {
      const mine = await client.query(
        `SELECT 1 FROM admin_tg_bindings WHERE user_id = $1::uuid AND telegram_user_id = $2::bigint`,
        [row.user_id, telegramUserId],
      );
      await client.query('ROLLBACK');
      return { ok: false, reason: mine.rowCount === 1 ? 'already_yours' : 'used' };
    }
    if (row.expired) { await client.query('ROLLBACK'); return { ok: false, reason: 'expired' }; }

    const stamped = await client.query(
      `UPDATE admin_tg_link_tokens SET used_at = NOW()
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
      `DELETE FROM admin_tg_bindings
        WHERE telegram_user_id = $1::bigint AND user_id <> $2::uuid
        RETURNING user_id::text AS user_id`,
      [telegramUserId, row.user_id],
    );
    await client.query(
      `INSERT INTO admin_tg_bindings (user_id, telegram_user_id, bound_at)
       VALUES ($1::uuid, $2::bigint, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET telegram_user_id = EXCLUDED.telegram_user_id, bound_at = NOW()`,
      [row.user_id, telegramUserId],
    );
    await client.query('COMMIT');
    return { ok: true, userId: row.user_id, movedFromUserId: moved.rows[0]?.user_id ?? null };
  } catch (err) {
    await client.query('ROLLBACK').catch((rbErr: unknown) => {
      logSwallowedFailure('telegram/admin', 'откат погашения ссылки', rbErr);
    });
    throw err;
  } finally {
    client.release();
  }
}

export type TelegramAdminLookup =
  | { outcome: 'admin'; userId: string; name: string | null }
  | { outcome: 'none' }
  | { outcome: 'unavailable' };

/**
 * Администратор ли пишет. Три исхода (§4.0): «не смог проверить» не равно
 * «не администратор». Строка без user_id — не привязка.
 */
export async function findTelegramAdmin(telegramUserId: number): Promise<TelegramAdminLookup> {
  if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) return { outcome: 'none' };
  try {
    const { rows } = await pool.query<{ user_id: string; name: string | null }>(
      `SELECT b.user_id::text AS user_id, NULLIF(btrim(u.name), '') AS name
         FROM admin_tg_bindings b
         JOIN users u ON u.id = b.user_id
        WHERE b.telegram_user_id = $1::bigint AND ${ownsAdminSql('u')}
        LIMIT 1`,
      [telegramUserId],
    );
    const row = rows[0];
    if (!row || typeof row.user_id !== 'string' || row.user_id.length === 0) return { outcome: 'none' };
    return { outcome: 'admin', userId: row.user_id, name: row.name ?? null };
  } catch (err) {
    console.error('[telegram/admin] администратор не проверен, SQLSTATE', (err as { code?: string })?.code ?? 'нет SQLSTATE');
    return { outcome: 'unavailable' };
  }
}

/** boundAt — ISO 8601: текстовую форму PostgreSQL Safari не разбирает. */
export interface AdminTelegramStatus { bound: boolean; boundAt: string | null }

/** Подключён ли Telegram у этого администратора — для админки. Отказ базы бросается. */
export async function adminTelegramStatus(userId: string): Promise<AdminTelegramStatus> {
  const { rows } = await pool.query<{ bound_at: Date }>(
    `SELECT bound_at FROM admin_tg_bindings WHERE user_id = $1::uuid`,
    [userId],
  );
  const row = rows[0];
  if (!row) return { bound: false, boundAt: null };
  return { bound: true, boundAt: new Date(row.bound_at).toISOString() };
}

/**
 * Отключить Telegram администратора: привязку и выданные, но не погашенные
 * ссылки. true — привязка была. Отказ базы бросается.
 */
export async function unbindAdminTelegram(userId: string): Promise<boolean> {
  const res = await pool.query(
    `WITH links AS (
       DELETE FROM admin_tg_link_tokens WHERE user_id = $1::uuid AND used_at IS NULL
     )
     DELETE FROM admin_tg_bindings WHERE user_id = $1::uuid`,
    [userId],
  );
  return (res.rowCount ?? 0) > 0;
}

export const ADMIN_TG_TEXT = {
  bound: 'Готово: этот Telegram подключён к Ведару как администратор. Права проверяются на каждом сообщении: '
    + 'снимут роль администратора на сайте — снимутся и здесь.',
  moved: 'Раньше этот Telegram был подключён к другому аккаунту администратора — теперь к вашему.',
  invalid: 'Ссылка подключения администратора не найдена. Возьмите новую в админке: «Подключить Telegram администратора».',
  malformed: 'Ссылка подключения администратора повреждена. Возьмите новую в админке.',
  used: 'Эта ссылка подключения уже использована. Если Telegram подключали не вы — отключите его в админке и возьмите новую ссылку.',
  alreadyYours: 'Этот Telegram уже подключён как администратор — по этой же ссылке. Делать ничего не нужно.',
  expired: 'Ссылка подключения устарела: она живёт 10 минут. Возьмите новую в админке.',
  notAdmin: 'Подключение не выполнено: у аккаунта, выдавшего ссылку, больше нет роли администратора.',
  noUser: 'Подключение не выполнено: Telegram не сообщил, кто нажал «Старт». Откройте ссылку ещё раз из личного чата с ботом.',
  failed: 'Подключение не выполнено: база не ответила. Возьмите новую ссылку в админке чуть позже.',
} as const;
