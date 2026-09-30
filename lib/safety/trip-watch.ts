/**
 * lib/safety/trip-watch.ts — единственный способ поставить и снять контроль
 * выхода (docs/safety/WATCH_MANIFEST.md, правило 1).
 *
 * Все пути создания — форма /register, чат Кузьмича в Telegram и MAX — пишут
 * одну и ту же строку `route_registrations` одним INSERT. Два INSERT'а в двух
 * местах — это две правды о том, какие поля у контроля обязательны, и они
 * разойдутся первой же новой колонкой.
 *
 * Сторожит этот контроль только `checkin-watchdog`; здесь — запись и закрытие.
 */
import { pool } from '@/lib/db-pool';

export type TripWatchSource = 'form' | 'telegram' | 'max';
export type TouristChannel = 'tg' | 'max';

export interface TripWatchInput {
  source: TripWatchSource;
  userId: string | null;
  routeName: string;
  routeDescription: string | null;
  startDate: string; // YYYY-MM-DD (по Камчатке)
  endDate: string;
  expectedReturnAt: Date | null;
  region: string;
  groupSize: number;
  groupMembers: unknown[] | null;
  leaderName: string;
  leaderPhone: string;
  leaderEmail: string | null;
  contactName: string;
  contactPhone: string;
  contactRelation: string | null;
  contactTelegramChatId: string | null;
  contactEmail: string | null;
  contactConsent: boolean;
  /** Канал к самому туристу — только у контроля из чата. */
  touristChat: { channel: TouristChannel; chatId: number } | null;
}

interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export async function createTripWatch(input: TripWatchInput, db: Queryable = pool): Promise<string> {
  const tripKind = input.startDate === input.endDate ? 'day' : 'multi';
  const { rows } = await db.query(
    `INSERT INTO route_registrations
       (user_id, route_name, route_description, start_date, end_date, region,
        group_size, group_members, leader_name, leader_phone, leader_email,
        emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
        emergency_contact_telegram_chat_id, emergency_contact_email,
        emergency_contact_consent, expected_return_at, trip_kind,
        source, tourist_chat_channel, tourist_chat_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING id`,
    [
      input.userId,
      input.routeName,
      input.routeDescription,
      input.startDate,
      input.endDate,
      input.region,
      input.groupSize,
      input.groupMembers ? JSON.stringify(input.groupMembers) : null,
      input.leaderName,
      input.leaderPhone,
      input.leaderEmail,
      input.contactName,
      input.contactPhone,
      input.contactRelation,
      input.contactTelegramChatId,
      input.contactEmail,
      input.contactConsent,
      input.expectedReturnAt,
      tripKind,
      input.source,
      input.touristChat?.channel ?? null,
      input.touristChat?.chatId ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (typeof id !== 'string') throw new Error('route_registrations: INSERT не вернул id');
  return id;
}

export interface OpenWatch {
  id: string;
  route_name: string;
  expected_return_at: Date | null;
}

/** Открытые контроли, поставленные из этого чата (новые первыми). */
export async function openWatchesForChat(channel: TouristChannel, chatId: number): Promise<OpenWatch[]> {
  const { rows } = await pool.query<OpenWatch>(
    `SELECT id, route_name, expected_return_at
       FROM route_registrations
      WHERE tourist_chat_channel = $1 AND tourist_chat_id = $2 AND completed_at IS NULL
      ORDER BY created_at DESC`,
    [channel, chatId],
  );
  return rows;
}

/**
 * Закрыть контроль: человек вернулся. Закрывает только ОТКРЫТЫЙ контроль и
 * говорит, закрыл ли: повторное «вернулся» не должно читаться как новое
 * закрытие.
 */
export async function closeTripWatch(id: string, by: 'link' | 'chat'): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE route_registrations
        SET completed_at = now(), closed_by = $2, updated_at = now()
      WHERE id = $1 AND completed_at IS NULL`,
    [id, by],
  );
  return (rowCount ?? 0) > 0;
}
