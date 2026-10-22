/**
 * GET /api/availability?month=YYYY-MM[&activity=trekking]
 *
 * Публичный. Возвращает посуточную картину доступности туров на месяц:
 *   - кол-во туров с открытыми слотами
 *   - суммарное кол-во свободных мест
 *   - минимальная цена дня
 *   - типы активностей
 *
 * Используется в публичном calendar-ре (/calendar) для рендера heatmap.
 */

import { occupiedOnDaySql } from '@/lib/bookings/occupancy';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { badQueryParam, calendarMonth, queryInput, queryText } from '@/lib/api/public-query';

export const dynamic = 'force-dynamic';

interface DayRow {
  date: string;
  tour_count: string;
  free_slots: string;
  price_from: string | null;
  activities: string[];
  operators: string;
}

/**
 * Вход — проверяется ДО базы (ревью #2642, третий круг): `?month=2099-13`
 * или `?month=abc` собирали из себя несуществующую дату, база отвечала 22008
 * или 22007, и человек читал «календарь временно не загружается». Вид
 * активности — без символа NUL (22021).
 */
const MonthQuery = z.object({
  month: calendarMonth.optional(),
  activity: queryText.optional(),
});
const PARAM_TEXT: Record<keyof z.input<typeof MonthQuery>, string> = {
  month: 'Месяц (month) — в формате ГГГГ-ММ, например 2027-07',
  activity: 'Вид активности (activity) содержит недопустимый символ',
};

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const parsed = MonthQuery.safeParse(queryInput(searchParams, ['month', 'activity'] as const));
  if (!parsed.success) {
    // Неверный вход — не отказ базы: 400 словами, база не спрашивалась.
    const bad = badQueryParam(parsed.error, PARAM_TEXT);
    return NextResponse.json(
      { success: false, error: bad?.error ?? PARAM_TEXT.month, param: bad?.param ?? null },
      { status: 400 },
    );
  }
  const monthParam = parsed.data.month ?? null;
  const activity   = parsed.data.activity ?? null;

  const now = new Date();
  const [year, month] = monthParam
    ? monthParam.split('-').map(Number)
    : [now.getFullYear(), now.getMonth() + 1];

  const dateFrom = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay  = new Date(year, month, 0).getDate();
  const dateTo   = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

  // Не показываем прошлые даты
  const effectiveFrom = dateFrom < now.toISOString().slice(0, 10)
    ? now.toISOString().slice(0, 10)
    : dateFrom;

  const params: unknown[] = [effectiveFrom, dateTo];
  let activityFilter = '';
  if (activity) {
    params.push(activity);
    activityFilter = `AND t.activity_type = $${params.length}`;
  }

  try {
    const { rows } = await pool.query<DayRow>(
      `SELECT
         ta.date::text,
         COUNT(DISTINCT ta.operator_tour_id)::text             AS tour_count,
         SUM(ta.available_slots - occ.taken)::text             AS free_slots,
         MIN(COALESCE(ta.base_price_override, t.base_price))::text AS price_from,
         ARRAY_AGG(DISTINCT t.activity_type)                   AS activities,
         COUNT(DISTINCT t.operator_id)::text                   AS operators
       FROM tour_availability ta
       JOIN operator_tours t ON ta.operator_tour_id = t.id
       CROSS JOIN LATERAL (
         -- Занятость из реальных броней (как у гейткипера), а не из
         -- booked_slots: счётчик обновляется только при оплате и не видит
         -- созданные-но-неоплаченные брони
         ${occupiedOnDaySql({ booking: 'ob', day: 'ta.date', tourId: 'ta.operator_tour_id' })}
       ) occ
       WHERE ta.date >= $1
         AND ta.date <= $2
         AND ta.is_cancelled = false
         AND ta.deleted_at IS NULL
         AND (ta.available_slots - occ.taken) > 0
         -- тур — шлюзом витрины (#2642): копия без deleted_at отдавала даты удалённого тура
         AND ${publicTourSql('t')}
         ${activityFilter}
       GROUP BY ta.date
       ORDER BY ta.date ASC`,
      params
    );

    const days = rows.map(r => ({
      date:       r.date,
      tourCount:  Number(r.tour_count),
      freeSlots:  Number(r.free_slots),
      priceFrom:  r.price_from !== null ? Number(r.price_from) : null,
      activities: (r.activities ?? []).filter(Boolean) as string[],
      operators:  Number(r.operators),
    }));

    return NextResponse.json({
      success: true,
      month:   `${year}-${String(month).padStart(2, '0')}`,
      days,
    });
  } catch (err) {
    // Текст исключения анониму не отдаётся: у PostgreSQL он называет таблицы,
    // колонки и statement timeout. В лог — имя проверки и SQLSTATE (§4.0).
    logSwallowedFailure('availability', 'календарь месяца', err);
    return NextResponse.json(
      { success: false, error: 'Календарь временно не загружается, попробуйте позже' },
      { status: 500 },
    );
  }
}
