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
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { tourFitsTripMonth } from '@/lib/planner/tour-season';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  activity_type: z.string().min(1).max(50),
  zone:          z.enum(['avachinsky', 'western', 'eastern', 'northern']).optional(),
  limit:         z.coerce.number().min(1).max(6).default(3),
  /** Месяц поездки, 1–12. Без него сезон тура не с чем сверять. */
  month:         z.coerce.number().int().min(1).max(12).optional(),
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
  season_start:      string | null;
  season_end:        string | null;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const parsed = QuerySchema.safeParse({
    activity_type: searchParams.get('activity_type'),
    zone:          searchParams.get('zone') || undefined,
    limit:         searchParams.get('limit'),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Параметр activity_type обязателен' },
      { status: 400 },
    );
  }

  const { activity_type, zone, limit, month } = parsed.data;
  const candidates = Math.min(Math.max(limit * 8, limit), 24);

  function take(rows: TourRow[]): TourRow[] {
    const fitted = month == null
      ? rows
      : rows.filter((r) => tourFitsTripMonth({
        title: r.title,
        seasonStart: r.season_start,
        seasonEnd: r.season_end,
        month,
      }));
    return fitted.slice(0, limit);
  }

  // If zone is specified, try filtered query first
  if (zone) {
    const { rows } = await pool.query<TourRow>(`
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
        ot.season_start::text AS season_start,
        ot.season_end::text AS season_end
      FROM operator_tours ot
      JOIN partners p ON p.id = ot.operator_id
      LEFT JOIN agent_route_knowledge ark ON ark.id = ot.agent_route_id
      WHERE ot.activity_type = $1
        AND ${publicTourSql('ot')}
        AND ark.zone = $2
      ORDER BY ot.rating DESC NULLS LAST, ot.base_price ASC
      LIMIT $3
    `, [activity_type, zone, candidates]);

    const picked = take(rows);
    // Зона ответила, но всё мимо месяца поездки — смотрим каталог шире,
    // а не отдаём январский тур на июль.
    if (picked.length > 0) {
      return NextResponse.json({ success: true, tours: picked });
    }
    // Otherwise fall through to global query
  }

  // Global query (no zone filter)
  const { rows } = await pool.query<TourRow>(`
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
        ot.season_start::text AS season_start,
        ot.season_end::text AS season_end
    FROM operator_tours ot
    JOIN partners p ON p.id = ot.operator_id
    WHERE ot.activity_type = $1
      AND ${publicTourSql('ot')}
    ORDER BY ot.rating DESC NULLS LAST, ot.base_price ASC
    LIMIT $2
  `, [activity_type, candidates]);

  return NextResponse.json({ success: true, tours: take(rows) });
}
