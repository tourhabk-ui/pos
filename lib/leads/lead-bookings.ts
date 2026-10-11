/**
 * Лид → бронь (CRM фаза 2, #2313; миграция 1214).
 *
 * Перепись 09.10: «Лид не доводится до сделки» — у лида не было ссылки на
 * бронь, «Сделку» ставили руками, и по какой брони сделка, не знал никто.
 * Теперь оператор заводит бронь кнопкой с карточки лида: бронь помнит лид
 * (`operator_bookings.lead_id`), лид становится «Сделкой» в том же запросе,
 * а карточка лида показывает его брони.
 */

import { pool } from '@/lib/db-pool';

export interface LeadBookingRow {
  id: string;
  booking_date: string;
  booking_status: string;
  participants: number;
  tour_title: string;
}

/** Брони лида: прочитаны — список (возможно пустой), не прочитаны — отказ. */
export type LeadBookings =
  | { kind: 'ok'; rows: LeadBookingRow[] }
  | { kind: 'failed' };

/**
 * Брони, заведённые из лида. Оператор видит только брони своих туров
 * (`operatorId`), администратор (`null`) — все.
 *
 * Отказ — не «броней нет» (§4.0): карточка скажет «не прочитались», а
 * причина с SQLSTATE останется в логе. Так же терпится и колонка до
 * миграции 1214 (42703): карточка лида откроется, блок броней — нет.
 */
export async function bookingsForLead(leadId: string, operatorId: string | null): Promise<LeadBookings> {
  try {
    const { rows } = await pool.query<LeadBookingRow>(
      `SELECT b.id::text AS id, to_char(b.booking_date, 'YYYY-MM-DD') AS booking_date,
              b.booking_status, b.participants, t.title AS tour_title
         FROM operator_bookings b
         JOIN operator_tours t ON t.id = b.operator_tour_id
        WHERE b.lead_id = $1::uuid
          AND ($2::uuid IS NULL OR t.operator_id = $2::uuid)
        ORDER BY b.created_at DESC
        LIMIT 20`,
      [leadId, operatorId],
    );
    return { kind: 'ok', rows };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? '?';
    console.error(`[leads/bookings] брони лида не прочитаны (SQLSTATE ${code}):`, err instanceof Error ? err.message : err);
    return { kind: 'failed' };
  }
}
