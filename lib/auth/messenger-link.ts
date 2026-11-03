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
import { query } from '@/lib/database';

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
    if (!owner || owner === holder?.id) return null;

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
