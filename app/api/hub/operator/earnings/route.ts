/**
 * GET /api/hub/operator/earnings
 * Сводка оператора за 30 дней: брони и выручка по оплаченным неотменённым.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { CANCELLED_STATUS_PARAM } from '@/lib/payments/release-eligibility';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const userOrResponse = await requireOperator(request);
  if (userOrResponse instanceof NextResponse) return userOrResponse;

  const operatorId = await getOperatorPartnerId(userOrResponse.userId);
  if (!operatorId) {
    return NextResponse.json({ success: false, error: 'Профиль оператора не найден' }, { status: 403 });
  }

  // Брони за 30 дней по дням. Выручка («Прямых продаж») — только
  // ОПЛАЧЕННЫЕ и НЕ отменённые: прежде сумма шла по всем броням, включая
  // отменённые и неоплаченные, и оператор видел как продажи деньги, которых
  // не было. Счётчики броней остаются по всем — это воронка, не деньги.
  let bookingsRows: Array<Record<string, unknown>>;
  try {
    const bookingsResult = await pool.query(
      `SELECT
         COUNT(*) AS total_bookings,
         COALESCE(SUM(b.final_price) FILTER (
           WHERE b.payment_status = 'paid' AND b.booking_status <> ALL($2::text[])
         ), 0) AS total_revenue,
         COUNT(*) FILTER (WHERE b.booking_status = 'confirmed') AS confirmed_count,
         COUNT(*) FILTER (WHERE b.booking_status = 'new') AS pending_count,
         DATE(b.created_at) AS date
       FROM operator_bookings b
       JOIN operator_tours t ON b.operator_tour_id = t.id
       WHERE t.operator_id = $1
         AND b.deleted_at IS NULL
         AND b.created_at > NOW() - INTERVAL '30 days'
       GROUP BY DATE(b.created_at)
       ORDER BY date DESC`,
      [operatorId, CANCELLED_STATUS_PARAM]
    );
    bookingsRows = bookingsResult.rows;
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[hub/operator/earnings] сводка не прочитана, SQLSTATE ${code}:`, err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Не удалось посчитать доходы. Попробуйте позже.' },
      { status: 500 },
    );
  }

  // Блока партнёрских кликов здесь больше нет (25.09): он читал
  // affiliate_clicks с source = 'operator_page_<id>', а такой source не пишет
  // НИКТО в репозитории. Карточка «Партнёрский трафик» всегда показывала 0 —
  // и выглядело это как «клики были, но ноль», а не «не считаем вовсе».
  // Немой .catch(() => ({ rows: [] })) скрывал заодно и падение запроса.

  const sum = (key: string, parse: (v: string) => number) =>
    bookingsRows.reduce((s, r) => s + parse(String(r[key] ?? '0')), 0);

  return NextResponse.json({
    success: true,
    periodDays: 30,
    summary: {
      totalBookings: sum('total_bookings', (v) => parseInt(v, 10)),
      totalRevenue: sum('total_revenue', (v) => parseFloat(v)),
      confirmedBookings: sum('confirmed_count', (v) => parseInt(v, 10)),
      pendingBookings: sum('pending_count', (v) => parseInt(v, 10)),
    },
    bookingsByDay: bookingsRows,
  });
}
