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
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { orderOffersBy } from '@/lib/tours/offer-order';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  activity_type: z.string().min(1).max(50),
  zone:          z.enum(['avachinsky', 'western', 'eastern', 'northern']).optional(),
  limit:         z.coerce.number().min(1).max(6).default(3),
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
}

const SELECT = `
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
        ${nearestFreeDateSql('ot')} AS nearest_free_date
      FROM operator_tours ot
      JOIN partners p ON p.id = ot.operator_id`;

/** Правило 1в, затем потолок. */
function firstByRule(rows: readonly TourRow[], limit: number): TourRow[] {
  return orderOffersBy(rows, (r) => ({ id: String(r.id), nearestFreeDate: r.nearest_free_date ?? null })).slice(0, limit);
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const parsed = QuerySchema.safeParse({
    activity_type: searchParams.get('activity_type'),
    zone:          searchParams.get('zone') || undefined,
    // Без параметра — умолчание схемы (3): null приводился к 0 и давал 400.
    limit:         searchParams.get('limit') ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Параметр activity_type обязателен' },
      { status: 400 },
    );
  }

  const { activity_type, zone, limit } = parsed.data;

  try {
    // If zone is specified, try filtered query first
    if (zone) {
      const { rows } = await pool.query<TourRow>(`${SELECT}
        LEFT JOIN agent_route_knowledge ark ON ark.id = ot.agent_route_id
        WHERE ot.activity_type = $1
          AND ${publicTourSql('ot')}
          AND ark.zone = $2
      `, [activity_type, zone]);

      // If zone filter returned results, use them
      if (rows.length > 0) {
        return NextResponse.json({ success: true, tours: firstByRule(rows, limit) });
      }
      // Otherwise fall through to global query
    }

    // Global query (no zone filter)
    const { rows } = await pool.query<TourRow>(`${SELECT}
      WHERE ot.activity_type = $1
        AND ${publicTourSql('ot')}
    `, [activity_type]);

    return NextResponse.json({ success: true, tours: firstByRule(rows, limit) });
  } catch (err) {
    // Отказ не выдаётся за «туров нет» (§4.0): 500 и SQLSTATE в лог.
    const e = err as { code?: string; message?: string } | undefined;
    console.error('[planner/tours-for-day] туры дня не прочитались', { sqlstate: e?.code, message: e?.message });
    return NextResponse.json({ success: false, error: 'Туры не загрузились, попробуйте позже' }, { status: 500 });
  }
}
