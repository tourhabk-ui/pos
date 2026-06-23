import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { semanticSearch } from '@/lib/ai/embeddings';
import { getRouteSearchCache, setRouteSearchCache } from '@/lib/ai/route-knowledge';

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
  similarity?: number;
}

const ENRICH_SQL = `
  SELECT
    r.id,
    r.title,
    r.distance_km,
    r.difficulty_level,
    r.zone,
    ARRAY_AGG(p.name ORDER BY rw.position) FILTER (WHERE p.name IS NOT NULL) AS waypoint_names
  FROM kamchatka_routes r
  LEFT JOIN route_waypoints rw ON rw.route_id = r.id
  LEFT JOIN places p ON p.id = rw.place_id
  WHERE r.id = ANY($1::uuid[])
  GROUP BY r.id, r.title, r.distance_km, r.difficulty_level, r.zone
`;

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const parsed = QuerySchema.safeParse({ q: searchParams.get('q') ?? '' });
  if (!parsed.success) return NextResponse.json({ routes: [], semantic: false });

  const rawQ = parsed.data.q.trim();

  // Семантический поиск для запросов ≥ 3 символов
  if (rawQ.length >= 3) {
    const cached = getRouteSearchCache(rawQ) as { routes: RouteRow[]; semantic: boolean } | null;
    if (cached) {
      return NextResponse.json({ ...cached, cache_hit: true });
    }

    try {
      const t0 = Date.now();
      const semanticResults = await semanticSearch(rawQ, 15);
      const latency_ms = Date.now() - t0;
      console.info('[search] semantic', { query_length: rawQ.length, result_count: semanticResults.length, latency_ms });

      if (semanticResults.length > 0) {
        const ids = semanticResults.map(r => r.id);
        const { rows } = await query<RouteRow>(ENRICH_SQL, [ids]);

        // Обогащаем SQL-данными, сохраняем порядок по схожести
        const byId = Object.fromEntries(rows.map(r => [r.id, r]));
        const ordered: RouteRow[] = semanticResults
          .filter(r => byId[r.id])
          .map(r => ({ ...byId[r.id], similarity: r.similarity }));

        setRouteSearchCache(rawQ, { routes: ordered, semantic: true });
        return NextResponse.json({ routes: ordered, semantic: true });
      }
    } catch (err) {
      console.error('[search] semantic error', { query_length: rawQ.length, error: err instanceof Error ? err.message : String(err) });
      // Семантический поиск упал → ILIKE фоллбэк ниже
    }
  }

  // ILIKE фоллбэк: только по названию
  const like = `%${rawQ}%`;
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
    [like],
  );

  return NextResponse.json({ routes: result.rows, semantic: false });
}
