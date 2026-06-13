import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  q: z.string().min(1).max(100),
});

interface RouteRow {
  id: string;
  title: string;
  distance_km: string | null;
  difficulty_level: string | null;
  zone: string | null;
  waypoint_names: string[] | null;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const parsed = QuerySchema.safeParse({ q: searchParams.get('q') ?? '' });
  if (!parsed.success) {
    return NextResponse.json({ routes: [] });
  }

  const q = `%${parsed.data.q}%`;

  const result = await query<RouteRow>(
    `SELECT
       r.id,
       r.title,
       r.distance_km,
       r.difficulty_level,
       r.zone,
       ARRAY_AGG(p.name ORDER BY rw.position) FILTER (WHERE p.name IS NOT NULL) AS waypoint_names
     FROM kamchatka_routes r
     LEFT JOIN route_waypoints rw ON rw.route_id = r.id
     LEFT JOIN places p ON p.id = rw.place_id
     WHERE r.title ILIKE $1
     GROUP BY r.id, r.title, r.distance_km, r.difficulty_level, r.zone
     ORDER BY r.title
     LIMIT 15`,
    [q],
  );

  return NextResponse.json({ routes: result.rows });
}
