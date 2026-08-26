import { NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') ?? 'all'; // places | routes | all
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '12', 10), 50);

  const results: Record<string, unknown> = {};

  if (type === 'all' || type === 'places') {
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.location_type, p.lat, p.lng, p.view_count,
              (SELECT CASE WHEN ai.model IN ('wikimedia', 'manual-upload') THEN '/api/images/route/' || p.ark_id END
               FROM ai_route_images ai WHERE ai.route_id = p.ark_id LIMIT 1) AS image_url
       FROM places p
       ORDER BY p.view_count DESC, p.created_at DESC
       LIMIT $1`,
      [limit]
    );
    results.places = rows;
  }

  if (type === 'all' || type === 'routes') {
    // id — в пространстве VIEW agent_route_knowledge (COALESCE(ark_id, id)):
    // _TrendingClient строит из него href на /routes/[id], который ищет по
    // VIEW. Голый kamchatka_routes.id у записи с заполненным ark_id там не
    // находился — 404 из «популярного» на /trending (тот же разбор, что
    // уже стоит в /api/routes/search/route.ts).
    const { rows } = await pool.query(
      `SELECT COALESCE(ark_id, id) AS id, title, difficulty, distance_km, duration_hours, activity_type, view_count
       FROM kamchatka_routes
       WHERE (is_visible = TRUE OR is_visible IS NULL) AND merged_into_id IS NULL
       ORDER BY view_count DESC, created_at DESC
       LIMIT $1`,
      [limit]
    );
    results.routes = rows;
  }

  return NextResponse.json(results);
}
