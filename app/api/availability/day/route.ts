/**
 * GET /api/availability/day?date=YYYY-MM-DD[&activity=trekking]
 *
 * Публичный. Возвращает все туры с открытыми слотами на конкретную дату.
 * Используется в публичном календаре при клике на день.
 */

import { occupiedOnDaySql } from '@/lib/bookings/occupancy';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { badQueryParam, calendarDay, queryInput, queryText } from '@/lib/api/public-query';

export const dynamic = 'force-dynamic';

interface TourRow {
  tour_id: string;
  title: string;
  description: string | null;
  activity_type: string | null;
  location_name: string | null;
  base_price: string;
  price_override: string | null;
  price_unit: string | null;
  duration_hours: string | null;
  duration_type: string | null;
  max_participants: number;
  min_participants: number;
  available_slots: number;
  booked_slots: number;
  free_slots: number;
  weather_status: string;
  operator_id: string;
  operator_name: string;
  operator_verified: boolean | null;
  operator_slug: string | null;
  operator_public: boolean | null;
  operator_rating: string | null;
  tags: string[] | null;
}

const ACTIVITY_RU: Record<string, string> = {
  trekking: 'Треккинг', fishing: 'Рыбалка', bear_watching: 'Медведи',
  helicopter: 'Вертолёт', thermal: 'Термальные', boat_trip: 'Морская прогулка',
  snowmobile: 'Снегоход', jeep: 'Джип-тур', eco: 'Эко-тур',
  diving: 'Дайвинг', ski: 'Фрирайд', cultural: 'Культура',
  photo: 'Фототур', camping: 'Кемпинг', other: 'Активный отдых',
};

/**
 * Вход — проверяется ДО базы (ревью #2642, третий круг). Одной регулярки
 * мало: `2099-02-30` формой проходит, а база отвечает 22008, и человек читал
 * «временно не загружаются» про день, которого нет в календаре. Вид
 * активности — без символа NUL (22021).
 */
const DayQuery = z.object({
  date: calendarDay,
  activity: queryText.optional(),
});
const PARAM_TEXT: Record<keyof z.input<typeof DayQuery>, string> = {
  date: 'Дата (date) — день календаря в формате ГГГГ-ММ-ДД, например 2027-07-15',
  activity: 'Вид активности (activity) содержит недопустимый символ',
};

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const parsed = DayQuery.safeParse(queryInput(searchParams, ['date', 'activity'] as const));
  if (!parsed.success) {
    // Неверный вход — не отказ базы: 400 словами, база не спрашивалась.
    const bad = badQueryParam(parsed.error, PARAM_TEXT);
    return NextResponse.json(
      { success: false, error: bad?.error ?? PARAM_TEXT.date, param: bad?.param ?? null },
      { status: 400 },
    );
  }
  const { date } = parsed.data;
  const activity = parsed.data.activity ?? null;

  // Не показываем прошлое
  const today = new Date().toISOString().slice(0, 10);
  if (date < today) {
    return NextResponse.json({ success: true, date, tours: [] });
  }

  const params: unknown[] = [date];
  let activityFilter = '';
  if (activity) {
    params.push(activity);
    activityFilter = `AND t.activity_type = $${params.length}`;
  }

  try {
    const { rows } = await pool.query<TourRow>(
      `SELECT
         t.id::text                                                           AS tour_id,
         t.title,
         t.description,
         t.activity_type,
         t.location_name,
         t.base_price::text,
         t.price_unit,
         ta.base_price_override::text                                        AS price_override,
         t.duration_hours::text,
         t.duration_type,
         t.max_participants,
         t.min_participants,
         ta.available_slots,
         occ.taken                                                           AS booked_slots,
         GREATEST(0, ta.available_slots - occ.taken)                         AS free_slots,
         ta.weather_status,
         p.id::text                                                          AS operator_id,
         p.name                                                              AS operator_name,
         p.is_verified                                                       AS operator_verified,
         p.slug                                                              AS operator_slug,
         p.is_public                                                         AS operator_public,
         p.rating::text                                                      AS operator_rating,
         -- Теги — из operator_tour_tags (их пишет кабинет): колонки tags у
         -- operator_tours нет, и прежнее t.tags роняло роут на 42703 при любом
         -- запросе — панель дня в /calendar не открывалась (найдено pg-тестом
         -- шлюза, ревью #2642).
         ARRAY(SELECT tt.tag::text FROM operator_tour_tags tt WHERE tt.tour_id = t.id ORDER BY tt.tag) AS tags
       FROM tour_availability ta
       JOIN operator_tours t ON ta.operator_tour_id = t.id
       JOIN partners p       ON t.operator_id = p.id
       CROSS JOIN LATERAL (
         -- Занятость из реальных броней (как у гейткипера), а не из
         -- booked_slots: счётчик обновляется только при оплате
         ${occupiedOnDaySql({ booking: 'ob', day: 'ta.date', tourId: 'ta.operator_tour_id' })}
       ) occ
       WHERE ta.date = $1
         AND ta.is_cancelled = false
         AND ta.deleted_at IS NULL
         AND (ta.available_slots - occ.taken) > 0
         -- тур — шлюзом витрины (#2642): копия без deleted_at отдавала даты удалённого тура
         AND ${publicTourSql('t')}
         ${activityFilter}
       ORDER BY
         COALESCE(ta.base_price_override, t.base_price) ASC,
         (ta.available_slots - occ.taken) DESC`,
      params
    );

    const tours = rows.map(r => ({
      tourId:         Number(r.tour_id),
      title:          r.title,
      description:    r.description?.slice(0, 200) ?? null,
      activityType:   r.activity_type,
      activityLabel:  r.activity_type ? (ACTIVITY_RU[r.activity_type] ?? r.activity_type) : null,
      locationName:   r.location_name,
      price:          r.price_override !== null ? Number(r.price_override) : Number(r.base_price),
      priceUnit:      r.price_unit,
      durationHours:  r.duration_hours !== null ? Number(r.duration_hours) : null,
      durationType:   r.duration_type,
      maxParticipants: r.max_participants,
      minParticipants: r.min_participants,
      availableSlots:  r.available_slots,
      bookedSlots:     r.booked_slots,
      freeSlots:       r.free_slots,
      weatherStatus:   r.weather_status,
      operator: {
        id:       r.operator_id,
        name:     r.operator_name,
        verified: r.operator_verified ?? false,
        slug:     r.operator_slug,
        isPublic: r.operator_public,
        rating:   r.operator_rating !== null ? Number(r.operator_rating) : null,
      },
      tags: r.tags ?? [],
    }));

    return NextResponse.json({ success: true, date, tours });
  } catch (err) {
    // Текст исключения анониму не отдаётся: у PostgreSQL он называет таблицы,
    // колонки и statement timeout. В лог — имя проверки и SQLSTATE (§4.0).
    logSwallowedFailure('availability-day', 'туры дня', err);
    return NextResponse.json(
      { success: false, error: 'Туры на эту дату временно не загружаются, попробуйте позже' },
      { status: 500 },
    );
  }
}
