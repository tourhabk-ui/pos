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
import { activitySpellings, canonicalActivity, knownActivityLabel } from '@/lib/tours/labels';

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

/**
 * Виды туров месяца для кнопок: канонический ключ без повторов, подпись из
 * общего словаря. Вид без подписи кнопки не получает — служебное слово
 * («horseback») человеку не показывается; тур виден под «Все типы».
 */
function monthActivities(types: readonly (string | null)[]): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const t of types) {
    if (!t) continue;
    const key = canonicalActivity(t);
    const label = knownActivityLabel(key, true);
    if (label && !seen.has(key)) seen.set(key, label);
  }
  return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

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
    // Все написания вида: кнопка «Джип-сафари» находит и `jeep`, и `jeep_safari`.
    params.push(activitySpellings(activity));
    activityFilter = `AND t.activity_type = ANY($${params.length}::text[])`;
  }

  // Общая часть запросов: даты месяца со свободными местами у туров витрины.
  const monthFrom = `
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
         AND ${publicTourSql('t')}`;

  try {
    // Кнопки видов — только из живых туров месяца (CLAUDE.md §0), без
    // фильтра по виду: иначе выбранная кнопка прятала бы остальные.
    const [{ rows }, kinds] = await Promise.all([
      pool.query<DayRow>(
        `SELECT
           ta.date::text,
           COUNT(DISTINCT ta.operator_tour_id)::text             AS tour_count,
           SUM(ta.available_slots - occ.taken)::text             AS free_slots,
           MIN(COALESCE(ta.base_price_override, t.base_price))::text AS price_from,
           ARRAY_AGG(DISTINCT t.activity_type)                   AS activities,
           COUNT(DISTINCT t.operator_id)::text                   AS operators
         ${monthFrom}
         ${activityFilter}
         GROUP BY ta.date
         ORDER BY ta.date ASC`,
        params,
      ),
      pool.query<{ activity_type: string | null }>(
        `SELECT DISTINCT t.activity_type ${monthFrom}`,
        [effectiveFrom, dateTo],
      ),
    ]);

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
      activities: monthActivities(kinds.rows.map((r) => r.activity_type)),
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
