/**
 * Вход через MAX/Telegram находит кабинет партнёра (03.11, миграция 1386).
 *
 * Вход искал только users.max_user_id / users.telegram_id, а подключение бота
 * пишет MAX/Telegram в partners / operator_members — и оператор попадал в
 * пустой профиль туриста max_<id>@max.local. Здесь: если по id никого нет
 * (или id держит ПУСТОЙ дубль-заглушка), а у id ровно один владелец
 * кабинета — id переносится на него. При неоднозначности не связываем.
 * Решение «кто владелец» и «пуст ли дубль» — SQL-функции миграции 1386,
 * общие с разовым переносом.
 */
import { query, pool } from '@/lib/database';
import { linkMessengerLogin } from '@/lib/partners/messenger-login';

export type MessengerChannel = 'max' | 'telegram';

export interface LinkedUserRow {
  id: string;
  email: string;
  name: string;
  role: string;
}

const COLUMN: Record<MessengerChannel, 'max_user_id' | 'telegram_id'> = {
  max: 'max_user_id',
  telegram: 'telegram_id',
};

/**
 * Вернуть пользователя-владельца кабинета, если id мессенджера нужно (и можно)
 * связать с ним; иначе null — вызывающий идёт прежним путём.
 * `holder` — тот, кто уже держит id в users (или null).
 */
export async function linkMessengerLoginToPartner(
  channel: MessengerChannel,
  extId: number,
  holder: { id: string } | null,
): Promise<LinkedUserRow | null> {
  if (!Number.isSafeInteger(extId) || extId <= 0) return null;
  const col = COLUMN[channel];
  try {
    const own = await query<{ owner: string | null }>(
      `SELECT vedar_messenger_owner($1, $2::bigint)::text AS owner`,
      [channel, extId],
    );
    const owner = own.rows[0]?.owner ?? null;
    if (!owner) return linkUnownedCard(channel, extId);
    if (owner === holder?.id) return null;

    // У владельца уже другой id этого мессенджера — не связываем и дубль не
    // выключаем (иначе человек остался бы без входа вовсе).
    const busy = await query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1::uuid AND ${col} IS NOT NULL AND ${col} <> $2::bigint) AS ok`,
      [owner, extId],
    );
    if (busy.rows[0]?.ok) return null;

    if (holder) {
      const empty = await query<{ ok: boolean }>(
        `SELECT vedar_messenger_placeholder_empty($1::uuid) AS ok`,
        [holder.id],
      );
      if (!empty.rows[0]?.ok) return null; // у дубля есть данные — не трогаем
      await query(
        `UPDATE users SET ${col} = NULL, is_active = FALSE WHERE id = $1::uuid AND ${col} = $2::bigint`,
        [holder.id, extId],
      );
      await query(`DELETE FROM user_sessions WHERE user_id = $1::uuid`, [holder.id]);
    }

    const linked = await query<LinkedUserRow>(
      `UPDATE users SET ${col} = $2::bigint
        WHERE id = $1::uuid AND (${col} IS NULL OR ${col} = $2::bigint)
          AND NOT EXISTS (SELECT 1 FROM users o WHERE o.${col} = $2::bigint AND o.id <> $1::uuid)
        RETURNING id, email, name, role`,
      [owner, extId],
    );
    return linked.rows[0] ?? null;
  } catch (err) {
    console.error('[auth/messenger-link] связать вход не удалось:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Карточка без аккаунта (04.11): partners.user_id пуст, но этот человек открыл
 * ссылку подключения op_ в личном диалоге (max_owner_user_id /
 * telegram_owner_user_id). Это ровно то, что делает кнопка администратора
 * «Вход через MAX / Telegram» (lib/partners/messenger-login) — тот же код,
 * та же модель доверия: подтверждённый мессенджер владельца карточки.
 * Только если такая карточка одна и выбранный ею мессенджер совпадает с
 * каналом входа. Никого не выключает: найденный турист получает роль
 * карточки, иначе заводится аккаунт-заглушка.
 */
async function linkUnownedCard(channel: MessengerChannel, extId: number): Promise<LinkedUserRow | null> {
  const ownerCol = channel === 'max' ? 'max_owner_user_id' : 'telegram_owner_user_id';
  const cards = await query<{ id: string }>(
    `SELECT id::text AS id FROM partners
      WHERE user_id IS NULL AND ${ownerCol} = $1::bigint
        ${channel === 'telegram' ? 'AND max_owner_user_id IS NULL' : ''}
      LIMIT 2`,
    [extId],
  );
  if (cards.rows.length !== 1) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await linkMessengerLogin(client, cards.rows[0].id);
    if (res.outcome !== 'linked' || res.via !== channel) {
      await client.query('ROLLBACK');
      return null;
    }
    const u = await client.query<LinkedUserRow>(
      `SELECT u.id::text AS id, u.email, u.name, u.role FROM users u
         JOIN partners p ON p.user_id::text = u.id::text WHERE p.id = $1::uuid`,
      [cards.rows[0].id],
    );
    await client.query('COMMIT');
    return u.rows[0] ?? null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
