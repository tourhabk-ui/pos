/**
 * GET /api/trip-plans/search-routes?q=&activity=&limit=
 * Поиск маршрутов из kamchatka_routes для планировщика поездок.
 * Возвращает поля, нужные _TripPlanClient.
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const q        = searchParams.get('q')?.trim() ?? '';
  const activity = searchParams.get('activity')?.trim() ?? '';
  const limit    = Math.min(20, Math.max(1, parseInt(searchParams.get('limit') ?? '12', 10)));

  const conditions: string[] = [];
  const values: unknown[]    = [];
  let idx = 1;

  if (q) {
    conditions.push(`(r.title ILIKE $${idx} OR r.description ILIKE $${idx} OR r.zone ILIKE $${idx})`);
    values.push(`%${q}%`);
    idx++;
  }

  if (activity) {
    conditions.push(`r.activity_type ILIKE $${idx}`);
    values.push(`%${activity}%`);
    idx++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(limit);

  const result = await query(
    `SELECT r.id, r.title, r.zone, r.difficulty, r.distance_km,
            r.duration_hours, r.season, r.activity_type, r.mchs_registration_required
     FROM kamchatka_routes r
     ${where}
     ORDER BY r.title
     LIMIT $${idx}`,
    values
  );

  return NextResponse.json({
    success: true,
    data: result.rows.map(r => ({
      id:           r.id              as string,
      title:        r.title           as string,
      zone:         r.zone            as string | null,
      difficulty:   r.difficulty      as string | null,
      distanceKm:   r.distance_km  != null ? parseFloat(r.distance_km  as string) : null,
      durationHours:r.duration_hours != null ? parseFloat(r.duration_hours as string) : null,
      season:       r.season          as string | null,
      activityType: r.activity_type   as string | null,
      mchsRequired: r.mchs_registration_required as boolean,
    })),
  });
}
