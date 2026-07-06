/**
 * GET /api/tours/[id]/slots
 * Публичный. Возвращает ближайшие доступные даты из tour_availability для operator_tour_id.
 *
 * Занятость считается из operator_bookings (та же логика, что у гейткипера
 * /api/hub/bookings/create), а НЕ из счётчика booked_slots: счётчик
 * инкрементится только при оплате, поэтому не видит созданные-но-неоплаченные
 * брони — показывал места, по которым бронь была бы отклонена.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const tourId = parseInt(params.id, 10);
    if (!tourId) return NextResponse.json({ success: false, error: 'Invalid id' }, { status: 400 });

    const { rows } = await pool.query(
      `SELECT
         ta.date::text AS date,
         ta.available_slots,
         occ.taken AS booked_slots,
         GREATEST(0, LEAST(ta.available_slots, COALESCE(ot.max_participants, ta.available_slots)) - occ.taken) AS free_slots
       FROM tour_availability ta
       JOIN operator_tours ot ON ot.id = ta.operator_tour_id
       CROSS JOIN LATERAL (
         SELECT COALESCE(SUM(ob.participants), 0)::int AS taken
         FROM operator_bookings ob
         WHERE ob.operator_tour_id = ta.operator_tour_id
           AND ob.booking_date = ta.date
           AND ob.booking_status NOT IN ('cancelled', 'rejected')
       ) occ
       WHERE ta.operator_tour_id = $1
         AND ta.date >= CURRENT_DATE
         AND ta.is_cancelled = false
         AND ta.deleted_at IS NULL
         AND GREATEST(0, LEAST(ta.available_slots, COALESCE(ot.max_participants, ta.available_slots)) - occ.taken) > 0
       ORDER BY ta.date ASC
       LIMIT 30`,
      [tourId]
    );

    return NextResponse.json({ success: true, slots: rows });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка загрузки дат' }, { status: 500 });
  }
}
