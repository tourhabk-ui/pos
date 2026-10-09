/**
 * Кто может читать бронь тура: её турист, агент, который её завёл, оператор
 * тура, администратор. Одно правило для роутов чтения `/api/bookings/[id]/*`.
 *
 * До 09.10 `GET /api/bookings/[id]/logs` отвечал любому вошедшему: журнал
 * статусов любой брони по порядковому номеру, с именем и почтой того, кто
 * статус менял (pd-guard §3: проверка роли без проверки владения — не
 * защита). Найдено переписью кабинетов под CRM (#2325, шаг 0в).
 *
 * Три исхода (§4.0): `unknown` — спросить базу не смогли; это не «нет
 * доступа», вызывающий отвечает 503 и пишет причину в лог.
 */
import { pool } from '@/lib/db-pool';
import { operatorOwnsBooking, type OperatorOwnership } from '@/lib/bookings/operator-owns';

export type BookingAccess = OperatorOwnership;

export interface BookingReader {
  userId: string;
  role?: string | null;
}

export async function canReadBooking(bookingId: string, reader: BookingReader): Promise<BookingAccess> {
  if (!/^\d+$/.test(bookingId)) return 'denied';
  if (reader.role === 'admin') return 'ok';
  if (reader.role === 'operator') return operatorOwnsBooking(bookingId, reader.userId);
  try {
    const { rows } = await pool.query(
      `SELECT 1
         FROM operator_bookings
        WHERE id = $1::bigint
          AND (user_id = $2 OR agent_user_id = $2)
          AND deleted_at IS NULL
        LIMIT 1`,
      [bookingId, reader.userId],
    );
    return rows.length > 0 ? 'ok' : 'denied';
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[bookings] canReadBooking отказ:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return 'unknown';
  }
}
