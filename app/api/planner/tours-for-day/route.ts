/**
 * GET /api/planner/tours-for-day
 *
 * Returns operator tours for a specific activity type, optionally filtered by zone.
 * Used by TripBuilder v2 to show marketplace tours on day cards.
 *
 * Query params:
 *   activity_type -- type of activity (fishing, trekking, volcano ...)
 *   zone          -- optional: filter by geographic zone (avachinsky, western, eastern, northern)
 *   limit         -- number of tours (default 3, max 6)
 *
 * Порядок — правило 1в (слово владельца 29.10, lib/tours/offer-order):
 * сначала туры со свободной датой по ближайшему выезду, остальные — жребием
 * дня. До 29.10 здесь стояли рейтинг и «дешевле выше». Потолок `limit`
 * отрезается после порядка, в SQL нет ни ORDER BY, ни LIMIT.
 *
 * `date` — дата дня плана (#3338). Прогон 13.11: на 21.11.2026 карточка дня
 * звала на «Восхождение на Горелый» с выездами 15.07–15.10.2027 — эта ссылка
 * брала любой тур вида и зоны мимо проверки движка (lib/planner/tour-day-fit).
 * С датой правило то же, что у движка: тур с календарём — только если в этот
 * день у него есть свободные места, без календаря — день в сезоне выездов.
 * Подходящего нет — пустой список, и карточка дня тура не предлагает.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { nearestFreeDateInWindowSql, nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { keepsScheduleSql } from '@/lib/tours/schedule';
import { catalogRowFitsDay } from '@/lib/planner/tour-day-fit';
import { kamchatkaToday } from '@/lib/planner/calendar-days';
import { orderOffersBy } from '@/lib/tours/offer-order';
import { zoneMatchSql } from '@/lib/planner/zone-match';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  activity_type: z.string().min(1).max(50),
  zone:          z.enum(['avachinsky', 'western', 'eastern', 'northern']).optional(),
  limit:         z.coerce.number().min(1).max(6).default(3),
  /** Дата дня плана 'YYYY-MM-DD': туры только с выездом в этот день. */
  date:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

interface TourRow {
  id:                string;
  title:             string;
  short_description: string | null;
  base_price:        string;
  price_unit:        string | null;
  duration_hours:    number | null;
  tour_image:        string | null;
  operator_name:     string;
  operator_slug:     string;
  /** Ближайшая дата со свободными местами ('YYYY-MM-DD'); нет — null. */
  nearest_free_date: string | null;
  /** Только с `date`: сезон, длительность, ведёт ли тур календарь, места в этот день. */
  season_start?:     string | null;
  season_end?:       string | null;
  duration_type?:    string | null;
  multi_day_count?:  number | null;
  keeps_schedule?:   boolean;
  free_on_date?:     string | null;
}

/** Столбцы для проверки дня; `dateParam` — номер параметра с датой дня. */
function dayColumns(dateParam: string): string {
  return `,
        ot.season_start::text AS season_start,
        ot.season_end::text   AS season_end,
        ot.duration_type,
        ot.multi_day_count,
        ${keepsScheduleSql('ot.id')} AS keeps_schedule,
        ${nearestFreeDateInWindowSql('ot', dateParam, dateParam)} AS free_on_date`;
}

const SELECT_HEAD = `
      SELECT
        ot.id,
        ot.slug,
        ot.title,
        ot.short_description,
        ot.base_price::text,
        ot.price_unit,
        ot.duration_hours,
        ot.tour_image,
        p.name  AS operator_name,
        p.slug  AS operator_slug,
        ${nearestFreeDateSql('ot')} AS nearest_free_date`;
const SELECT_FROM = `
      FROM operator_tours ot
      JOIN partners p ON p.id = ot.operator_id`;

/** Ответу — только поля превью: служебные столбцы проверки дня не уходят. */
function preview(r: TourRow) {
  const { season_start: _s, season_end: _e, duration_type: _t, multi_day_count: _m, keeps_schedule: _k, free_on_date: _f, ...rest } = r;
  return rest;
}

/** Выезд в день плана (если дата есть), правило 1в, затем потолок. */
function firstByRule(rows: readonly TourRow[], limit: number, date: string | undefined) {
  const today = kamchatkaToday();
  const fit = date ? rows.filter((r) => catalogRowFitsDay(r, date, today)) : rows;
  return orderOffersBy(fit, (r) => ({ id: String(r.id), nearestFreeDate: r.nearest_free_date ?? null }))
    .slice(0, limit)
    .map(preview);
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const parsed = QuerySchema.safeParse({
    activity_type: searchParams.get('activity_type'),
    zone:          searchParams.get('zone') || undefined,
    // Без параметра — умолчание схемы (3): null приводился к 0 и давал 400.
    limit:         searchParams.get('limit') ?? undefined,
    date:          searchParams.get('date') || undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Параметр activity_type обязателен' },
      { status: 400 },
    );
  }

  const { activity_type, zone, limit, date } = parsed.data;

  try {
    // If zone is specified, try filtered query first
    if (zone) {
      const { rows } = await pool.query<TourRow>(`${SELECT_HEAD}${date ? dayColumns('$3') : ''}${SELECT_FROM}
        LEFT JOIN agent_route_knowledge ark ON ark.id = ot.agent_route_id
        WHERE ot.activity_type = $1
          AND ${publicTourSql('ot')}
          -- Тот же предикат зоны, что у движка (E4): тур без зоны — городской.
          AND ${zoneMatchSql('ark', '$2')}
      `, date ? [activity_type, zone, date] : [activity_type, zone]);

      // Есть подходящие в зоне — они; нет — общий запрос, как раньше.
      const inZone = firstByRule(rows, limit, date);
      if (inZone.length > 0) {
        return NextResponse.json({ success: true, tours: inZone });
      }
      // Otherwise fall through to global query
    }

    // Global query (no zone filter)
    const { rows } = await pool.query<TourRow>(`${SELECT_HEAD}${date ? dayColumns('$2') : ''}${SELECT_FROM}
      WHERE ot.activity_type = $1
        AND ${publicTourSql('ot')}
    `, date ? [activity_type, date] : [activity_type]);

    return NextResponse.json({ success: true, tours: firstByRule(rows, limit, date) });
  } catch (err) {
    // Отказ не выдаётся за «туров нет» (§4.0): 500 и SQLSTATE в лог.
    const e = err as { code?: string; message?: string } | undefined;
    console.error('[planner/tours-for-day] туры дня не прочитались', { sqlstate: e?.code, message: e?.message });
    return NextResponse.json({ success: false, error: 'Туры не загрузились, попробуйте позже' }, { status: 500 });
  }
}
