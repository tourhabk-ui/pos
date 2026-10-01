/**
 * Популярные места и маршруты — один загрузчик для /trending и GET /api/trending.
 *
 * До 01.10 страница была оболочкой: список клиент тянул из API в браузере, и
 * поисковик видел 21–23 слова вместо мест (аудит vedarai.ru 01.10). Тогда же
 * найдено ещё три расхождения с остальным сайтом, исправленные здесь:
 *
 *   - места брались без is_visible и без слитых — в «популярное» могла попасть
 *     скрытая карточка, а ссылка на неё отвечала 404;
 *   - снимок брался из ПРОИЗВОЛЬНОЙ строки ai_route_images: попадалась
 *     нарисованная — картинки не было, хотя настоящая лежала рядом;
 *   - ссылки шли по UUID и уходили редиректом на ЧПУ (476 таких редиректов на
 *     сайте) — теперь отдаётся slug.
 */
import { pool } from '@/lib/db-pool';
import { shownPhotoSql } from '@/lib/images/origin';
import { NOT_MERGED } from '@/lib/places/aliases';

export interface TrendingPlace {
  id: string;
  /** ЧПУ места; null — ссылка по id. */
  slug: string | null;
  name: string;
  location_type: string | null;
  view_count: number;
  image_url: string | null;
}

export interface TrendingRoute {
  /** id в пространстве карточки маршрута: COALESCE(ark_id, id). */
  id: string;
  slug: string | null;
  title: string;
  difficulty: string | null;
  distance_km: number | null;
  duration_hours: number | null;
  activity_type: string | null;
  view_count: number;
}

export type TrendingKind = 'places' | 'routes' | 'all';

export async function loadTrendingPlaces(limit: number): Promise<TrendingPlace[]> {
  const { rows } = await pool.query<TrendingPlace>(
    `SELECT p.id::text AS id, p.slug, p.name, p.location_type,
            COALESCE(p.view_count, 0)::int AS view_count,
            CASE WHEN EXISTS (SELECT 1 FROM ai_route_images ai
                               WHERE ai.route_id = p.ark_id
                                 AND ${shownPhotoSql('ai.model')})
                 THEN '/api/images/route/' || p.ark_id END AS image_url
     FROM places p
     WHERE p.is_visible = TRUE
       AND ${NOT_MERGED('p')}
     ORDER BY p.view_count DESC NULLS LAST, p.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function loadTrendingRoutes(limit: number): Promise<TrendingRoute[]> {
  // id — в пространстве VIEW agent_route_knowledge (COALESCE(ark_id, id)):
  // /routes/[id] ищет по VIEW, голый kamchatka_routes.id у записи с ark_id
  // там не находится. Двойник места (slug совпал с видимым местом) отвечает
  // 308 на карточку места — в «популярные маршруты» он не идёт, как и в sitemap.
  const { rows } = await pool.query<TrendingRoute>(
    `SELECT COALESCE(ark_id, id) AS id, slug, title, difficulty,
            distance_km::float AS distance_km, duration_hours::float AS duration_hours,
            activity_type, COALESCE(view_count, 0)::int AS view_count
     FROM kamchatka_routes
     WHERE (is_visible = TRUE OR is_visible IS NULL) AND merged_into_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM places tp
                        WHERE tp.slug = kamchatka_routes.slug AND tp.is_visible = TRUE)
     ORDER BY view_count DESC NULLS LAST, created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function loadTrending(kind: TrendingKind, limit: number): Promise<{
  places?: TrendingPlace[];
  routes?: TrendingRoute[];
}> {
  const [places, routes] = await Promise.all([
    kind === 'all' || kind === 'places' ? loadTrendingPlaces(limit) : Promise.resolve(undefined),
    kind === 'all' || kind === 'routes' ? loadTrendingRoutes(limit) : Promise.resolve(undefined),
  ]);
  return {
    ...(places ? { places } : {}),
    ...(routes ? { routes } : {}),
  };
}
