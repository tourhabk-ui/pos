/**
 * GET /api/hub/operator/earnings
 * Сводка оператора за 30 дней: брони и выручка по оплаченным неотменённым.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireOperatorOwner } from '@/lib/operators/team-access';
import { pool } from '@/lib/db-pool';
import { CANCELLED_STATUS_PARAM } from '@/lib/payments/release-eligibility';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // Деньги — только владельцу кабинета (CRM 2г): менеджеру выручка закрыта.
  const owner = await requireOperatorOwner(request);
  if (owner instanceof NextResponse) return owner;
  const operatorId = owner.partnerId;

  // Брони за 30 дней по дням. Выручка («Оплачено через платформу») — только
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

  // Получено напрямую (CRM фаза 2в, миграция 1215): деньги, которые
  // турист отдал оператору сам, по дате получения. Не оплата через
  // платформу — отдельная строка. Отказ — null («не прочитано»), сводка
  // при этом не падает: так же переживается и таблица до миграции.
  let directReceived: number | null = null;
  try {
    const direct = await pool.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(dp.amount), 0)::text AS total
         FROM booking_direct_payments dp
         JOIN operator_bookings b ON b.id = dp.booking_id
         JOIN operator_tours t ON t.id = b.operator_tour_id
        WHERE t.operator_id = $1
          AND dp.voided_at IS NULL
          AND dp.received_on > (NOW() AT TIME ZONE 'Asia/Kamchatka')::date - 30`,
      [operatorId],
    );
    directReceived = Number(direct.rows[0]?.total ?? 0);
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[hub/operator/earnings] оплаты напрямую не прочитаны, SQLSTATE ${code}:`, err instanceof Error ? err.message : err);
  }

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
      directReceived,
    },
    bookingsByDay: bookingsRows,
  });
}
