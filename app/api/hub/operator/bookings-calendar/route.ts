/**
 * GET /api/hub/operator/bookings-calendar?month=YYYY-MM
 * Бронирования сгруппированные по датам + доступность слотов для оператора.
 * Используется в календарном виде рабочего места.
 *
 * Кабинет — свой у владельца или командный у менеджера (CRM 2г). Брони с
 * суммами менеджер видит, как в списке броней; выручку месяца — нет:
 * деньги кабинета — владельцу (money_hidden, экран прячет выручку).
 */

import { occupiedOnDaySql } from '@/lib/bookings/occupancy';
import { NextRequest, NextResponse } from 'next/server';
import { requireOperatorTeam } from '@/lib/operators/team-access';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireOperatorTeam(req);
  if (ctx instanceof NextResponse) return ctx;
  const operatorId = ctx.partnerId;
  const owner = ctx.access.kind === 'owner';

  // Определяем диапазон месяца
  const monthParam = new URL(req.url).searchParams.get('month'); // YYYY-MM
  const now = new Date();
  const [year, month] = monthParam
    ? monthParam.split('-').map(Number)
    : [now.getFullYear(), now.getMonth() + 1];

  const dateFrom = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay  = new Date(year, month, 0).getDate();
  const dateTo   = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

  // Бронирования за месяц
  const bookingsResult = await pool.query(
    `SELECT
       b.id::text,
       b.operator_tour_id::text,
       t.title  AS tour_title,
       b.tourist_name,
       b.tourist_phone,
       b.tourist_email,
       b.participants,
       b.final_price,
       b.payment_status,
       b.booking_status,
       b.special_requests,
       b.created_at,
       b.booking_date::text AS date
     FROM operator_bookings b
     JOIN operator_tours t ON b.operator_tour_id = t.id
     WHERE t.operator_id = $1
       AND b.booking_date >= $2
       AND b.booking_date <= $3
       AND b.deleted_at IS NULL
     ORDER BY b.booking_date ASC, b.created_at ASC`,
    [operatorId, dateFrom, dateTo]
  );

  // Доступность слотов за месяц. Занятость (booked_slots для клиента) — из
  // реальных броней (SUM(participants), NOT IN cancelled/rejected), а не из
  // счётчика: счётчик пишет только payment-webhook («оплаченные»), и оператор
  // не видел неоплаченные заявки в заполненности своего календаря.
  const availResult = await pool.query(
    `SELECT
       ta.date::text,
       ta.available_slots,
       occ.taken AS booked_slots,
       ta.weather_status,
       ta.is_cancelled,
       t.title AS tour_title,
       t.id::text AS tour_id
     FROM tour_availability ta
     JOIN operator_tours t ON ta.operator_tour_id = t.id
     CROSS JOIN LATERAL (
${occupiedOnDaySql({ booking: 'ob', day: 'ta.date', tourId: 'ta.operator_tour_id' })}
     ) occ
     WHERE t.operator_id = $1
       AND ta.date >= $2
       AND ta.date <= $3
       AND ta.deleted_at IS NULL
     ORDER BY ta.date ASC`,
    [operatorId, dateFrom, dateTo]
  );

  // Группировка бронирований по дате
  const byDate: Record<string, typeof bookingsResult.rows> = {};
  for (const row of bookingsResult.rows) {
    const d = row.date as string;
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(row);
  }

  // Группировка доступности по дате
  const availByDate: Record<string, typeof availResult.rows> = {};
  for (const row of availResult.rows) {
    const d = row.date as string;
    if (!availByDate[d]) availByDate[d] = [];
    availByDate[d].push(row);
  }

  // Сводка
  const total     = bookingsResult.rows.length;
  const newCount  = bookingsResult.rows.filter(r => r.booking_status === 'new').length;
  const confirmed = bookingsResult.rows.filter(r => r.booking_status === 'confirmed').length;
  const completed = bookingsResult.rows.filter(r => r.booking_status === 'completed').length;
  const cancelled = bookingsResult.rows.filter(r => r.booking_status === 'cancelled').length;
  const revenue   = owner
    ? bookingsResult.rows
      .filter(r => r.booking_status !== 'cancelled')
      .reduce((s, r) => s + Number(r.final_price ?? 0), 0)
    : null;

  return NextResponse.json({
    success: true,
    month: `${year}-${String(month).padStart(2, '0')}`,
    bookings_by_date: byDate,
    availability_by_date: availByDate,
    summary: { total, new: newCount, confirmed, completed, cancelled, revenue },
    money_hidden: !owner,
  });
}
