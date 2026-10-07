/**
 * lib/auth/password-reset.ts — выдача и погашение токена сброса пароля.
 *
 * Единственное место, где токен рождается и гасится. Два входа у одной
 * механики:
 *  - форма «Забыли пароль?» (POST /api/auth/forgot-password) — ссылка уходит
 *    письмом, срок час;
 *  - администратор из карточки партнёра (POST /api/admin/operators/[id]/
 *    reset-link) — ссылку пересылает сам любым каналом, срок сутки: оператор
 *    в поле открывает её не сразу.
 *
 * Правила, которые держит сторож tests/unit/password-reset.test.ts:
 *  - в базе лежит ТОЛЬКО sha256 токена (миграция 1175); сырой токен — в
 *    ссылке и нигде больше, в лог не пишется;
 *  - токен одноразовый и срочный, оба предиката — в SQL погашения, а не в
 *    коде после SELECT: две вкладки с одной ссылкой не погасят её дважды;
 *  - новая выдача отзывает прежние непогашенные токены того же человека ОДНИМ
 *    оператором (DELETE и INSERT в одном CTE — два соединения пула не
 *    перемешают две выдачи): действует последняя ссылка, старые письма — нет.
 *    Исключение (ревью 07.10): форма «Забыли пароль?» доступна любому, кто
 *    знает адрес, поэтому ОНА отзывает только ссылки из формы и не трогает
 *    ссылку, выданную администратором; выдача администратором отзывает всё;
 *  - погашение снимает флаг force_password_change (пароль теперь выбран
 *    человеком), гасит остальные ссылки этого человека и закрывает все его
 *    сессии: тот, кто вошёл по старому или временному паролю, выходит;
 *  - отказ базы наружу не глушится — у вызывающего три исхода, не два (§4.0).
 */

import { createHash, randomBytes } from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { hashPassword } from '@/lib/auth/password';
import { getPublicBaseUrl } from '@/lib/config';

/** Срок ссылки из письма: час. Текст рядом с числом, чтобы не разъехались. */
export const SELF_SERVICE_TTL_MS = 60 * 60 * 1000;
export const SELF_SERVICE_TTL_TEXT = 'один час';
/** Срок ссылки, выданной администратором: сутки — её пересылают вручную. */
export const ADMIN_ISSUED_TTL_MS = 24 * 60 * 60 * 1000;
export const ADMIN_ISSUED_TTL_TEXT = 'сутки';

const TOKEN_BYTES = 32;

type Exec = Pick<PoolClient, 'query'>;

export function generateResetToken(randomSource: (n: number) => Buffer = randomBytes): string {
  return randomSource(TOKEN_BYTES).toString('base64url');
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function buildResetLink(token: string): string {
  return `${getPublicBaseUrl()}/auth/reset-password?token=${encodeURIComponent(token)}`;
}

export interface IssueResetInput {
  userId: string;
  /** Администратор, выдавший ссылку; для самообслуживания — не передаётся. */
  issuedBy?: string | null;
  ttlMs?: number;
}

export interface IssuedReset {
  token: string;
  link: string;
  expiresAt: Date;
}

/**
 * Выдать токен. Отзыв прежних и вставка нового — один оператор: с `exec = pool`
 * два отдельных запроса ушли бы по разным соединениям, и две одновременные
 * выдачи оставили бы два живых токена.
 *
 * Самообслуживание (issuedBy не задан) отзывает только самообслуживание;
 * администратор (issuedBy задан) отзывает всё.
 */
export async function issuePasswordResetToken(
  input: IssueResetInput,
  exec: Exec = pool,
): Promise<IssuedReset> {
  const token = generateResetToken();
  const ttl = input.ttlMs ?? SELF_SERVICE_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);

  await exec.query(
    `WITH gone AS (
       DELETE FROM password_reset_tokens
        WHERE user_id = $1::uuid AND used_at IS NULL
          AND ($4::uuid IS NOT NULL OR issued_by IS NULL)
     )
     INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, issued_by)
     VALUES ($1::uuid, $2, $3::timestamptz, $4::uuid)`,
    [input.userId, hashResetToken(token), expiresAt.toISOString(), input.issuedBy ?? null],
  );

  return { token, link: buildResetLink(token), expiresAt };
}

export type ConsumeResetResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' };

export const CONSUME_FAILURE_TEXT: Record<Extract<ConsumeResetResult, { ok: false }>['reason'], string> = {
  invalid: 'Ссылка для сброса пароля не найдена. Запросите новую.',
  expired: 'Ссылка для сброса пароля устарела. Запросите новую.',
  used:    'По этой ссылке пароль уже менялся. Запросите новую.',
};

/**
 * Погасить токен и поставить новый пароль — одной транзакцией на ОДНОМ
 * соединении (pool.query раздаёт запросы по разным соединениям, и BEGIN там
 * ничего бы не держал).
 *
 * Строка токена берётся FOR UPDATE: вторая вкладка с той же ссылкой ждёт
 * первую и видит used_at. Срок и одноразовость — предикаты UPDATE, а не
 * проверка в коде: между SELECT и UPDATE ничего не вклинится.
 */
export async function consumePasswordResetToken(
  token: string,
  newPassword: string,
): Promise<ConsumeResetResult> {
  const tokenHash = hashResetToken(token);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<{ id: string; user_id: string; expired: boolean; used: boolean }>(
      `SELECT id, user_id,
              expires_at <= NOW() AS expired,
              used_at IS NOT NULL AS used
         FROM password_reset_tokens
        WHERE token_hash = $1
        FOR UPDATE`,
      [tokenHash],
    );
    const row = found.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'invalid' };
    }
    if (row.used) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'used' };
    }
    if (row.expired) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'expired' };
    }

    const stamped = await client.query(
      `UPDATE password_reset_tokens
          SET used_at = NOW()
        WHERE id = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [row.id],
    );
    if (stamped.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'used' };
    }

    const passwordHash = await hashPassword(newPassword);
    await client.query(
      `UPDATE users
          SET password_hash = $1,
              preferences = COALESCE(preferences, '{}'::jsonb) - 'force_password_change',
              updated_at = NOW()
        WHERE id = $2::uuid`,
      [passwordHash, row.user_id],
    );
    // Остальные ссылки этого человека (например, выданная администратором
    // параллельно с письмом) после смены пароля не нужны.
    await client.query(
      `DELETE FROM password_reset_tokens WHERE user_id = $1::uuid AND id <> $2 AND used_at IS NULL`,
      [row.user_id, row.id],
    );
    // Сессия держится строкой user_sessions (lib/auth/jwt.ts), и ничто кроме
    // выхода её не закрывает. Сброс пароля делают, когда старый пароль знает
    // кто-то ещё — его вход закрывается здесь же, в той же транзакции.
    await client.query(
      `DELETE FROM user_sessions WHERE user_id = $1::uuid`,
      [row.user_id],
    );

    await client.query('COMMIT');
    return { ok: true, userId: row.user_id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
