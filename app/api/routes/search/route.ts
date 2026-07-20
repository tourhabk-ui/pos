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

// Колонка сложности в kamchatka_routes называется difficulty (миграция 056);
// difficulty_level здесь — имя поля ответа. Обращение r.difficulty_level
// роняло endpoint 500-кой на КАЖДЫЙ запрос (вскрылось навигаторным выбором
// маршрута по месту, 2026-07-19).
const ENRICH_SQL = `
  SELECT
    r.id,
    r.title,
    r.distance_km,
    r.difficulty AS difficulty_level,
    r.zone,
    ARRAY_AGG(p.name ORDER BY rw.position) FILTER (WHERE p.name IS NOT NULL AND p.is_visible = TRUE) AS waypoint_names
  FROM kamchatka_routes r
  LEFT JOIN route_waypoints rw ON rw.route_id = r.id
  LEFT JOIN places p ON p.id = rw.place_id
  WHERE r.id = ANY($1::uuid[]) AND r.is_visible = TRUE
  GROUP BY r.id, r.title, r.distance_km, r.difficulty, r.zone
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

  // ILIKE фоллбэк: по названию маршрута ИЛИ по названию места на нём —
  // навигаторный выбор ищет именно место («Авачинский» → все маршруты через него)
  const like = `%${rawQ}%`;
  try {
    const result = await query<RouteRow>(
      `SELECT
         r.id,
         r.title,
         r.distance_km,
         r.difficulty AS difficulty_level,
         r.zone,
         ARRAY_AGG(p.name ORDER BY rw.position) FILTER (WHERE p.name IS NOT NULL AND p.is_visible = TRUE) AS waypoint_names
       FROM kamchatka_routes r
       LEFT JOIN route_waypoints rw ON rw.route_id = r.id
       LEFT JOIN places p ON p.id = rw.place_id
       WHERE r.is_visible = TRUE
         AND (
           r.title ILIKE $1
           OR EXISTS (
             SELECT 1 FROM route_waypoints rw2
             JOIN places p2 ON p2.id = rw2.place_id
             WHERE rw2.route_id = r.id AND p2.is_visible = TRUE AND p2.name ILIKE $1
           )
         )
         -- Компактность вейпоинтов (bbox ≤ ~55 км) ЛИБО их отсутствие:
         -- мега-сборники «35 мест по всему краю» — не проходимые треки,
         -- их синтетическая геометрия рисуется паутиной (полевой скрин 20.07)
         AND COALESCE(
           (SELECT (MAX(p3.lat) - MIN(p3.lat)) <= 0.5 AND (MAX(p3.lng) - MIN(p3.lng)) <= 0.8
            FROM route_waypoints rw3
            JOIN places p3 ON p3.id = rw3.place_id
            WHERE rw3.route_id = r.id AND p3.lat IS NOT NULL AND p3.lng IS NOT NULL),
           TRUE
         )
       GROUP BY r.id, r.title, r.distance_km, r.difficulty, r.zone
       ORDER BY r.title
       LIMIT 15`,
      [like],
    );
    return NextResponse.json({ routes: result.rows, semantic: false });
  } catch (err) {
    // В поле лучше пустой список, чем 500 — UI покажет «ничего не нашлось»
    console.error('[search] fallback error', { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ routes: [], semantic: false });
  }
}
