/**
 * Фото маршрута из его точек — когда своих кадров у маршрута нет (04.10).
 *
 * Скрин владельца: «Вулкан Козельский» открывался заглушкой-компасом, хотя у
 * места «Козельский» три снимка (герой владельца и два кадра галереи, один —
 * Ильи Оноприйчука). Маршрут свои кадры берёт только из payload.photos и
 * ai_route_images по своему id; снимки мест, через которые он идёт, ему были
 * недоступны. §10: «без своего снимка — фото точки».
 *
 * Правила:
 *  - только точки ПУТИ: связь «рядом» (link_kind = 'nearby', §4.1) не даёт
 *    маршруту чужих видов — музей в 15 км от центра не фото подъёма;
 *  - только показываемые роды снимков (shownPhotoSql) — генерации нет;
 *  - по порядку прохождения, герой места первым, затем его галерея;
 *  - автор каждого кадра едет вместе с ним: подпись под фото называет
 *    автора ТОГО кадра, что на экране (владелец 04.10: «если фото Ильи —
 *    то и подпись его»).
 */
import { shownPhotoSql } from '@/lib/images/origin';

export const WAYPOINT_PHOTOS_LIMIT = 8;

/** $1 — kamchatka_routes.id маршрута. */
export const WAYPOINT_PHOTOS_SQL = `
  WITH wp AS (
    SELECT p.ark_id, p.name, MIN(rw.position) AS pos
      FROM route_waypoints rw
      JOIN places p ON p.id::text = rw.place_id::text
     WHERE rw.route_id::text = $1::text
       AND p.is_visible = TRUE
       AND p.merged_into_id IS NULL
       AND p.ark_id IS NOT NULL
       AND COALESCE(to_jsonb(rw)->>'link_kind', 'unknown') <> 'nearby'
     GROUP BY p.ark_id, p.name
  )
  SELECT u.url, u.author, wp.name AS place_name
    FROM wp
    JOIN LATERAL (
      SELECT '/api/images/route/' || wp.ark_id || '?v=' || EXTRACT(EPOCH FROM ai.created_at)::bigint AS url,
             NULLIF(btrim(ai.author), '') AS author, 0 AS ord
        FROM ai_route_images ai
       WHERE ai.route_id = wp.ark_id AND ${shownPhotoSql('ai.model')}
      UNION ALL
      SELECT '/api/images/place-gallery/' || g.ark_id || '/' || g.position
               || '?v=' || EXTRACT(EPOCH FROM g.created_at)::bigint,
             NULLIF(btrim(g.author), ''), g.position
        FROM place_gallery_photos g
       WHERE g.ark_id = wp.ark_id
    ) u ON TRUE
   ORDER BY wp.pos, u.ord
   LIMIT ${WAYPOINT_PHOTOS_LIMIT}`;

export interface WaypointPhotos {
  urls: string[];
  /** Автор КАЖДОГО кадра, тем же порядком; null — автора не знаем. */
  authors: Array<string | null>;
  /** Место, чей это кадр, тем же порядком — для подписи «Фото места …». */
  placeNames: string[];
}

export function toWaypointPhotos(rows: Array<{ url: unknown; author: unknown; place_name: unknown }>): WaypointPhotos {
  const out: WaypointPhotos = { urls: [], authors: [], placeNames: [] };
  for (const r of rows) {
    if (typeof r.url !== 'string' || out.urls.includes(r.url)) continue;
    out.urls.push(r.url);
    out.authors.push(typeof r.author === 'string' && r.author.trim() ? r.author.trim() : null);
    out.placeNames.push(typeof r.place_name === 'string' ? r.place_name : '');
  }
  return out;
}
