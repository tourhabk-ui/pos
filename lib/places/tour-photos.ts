/**
 * Снимки туров на странице и карточке МЕСТА без собственного фото (владелец
 * 21.11: «и на местах тоже фото не только маршрутах»; согласие партнёра и
 * лицензия не нужны — «делай без их согласия», 20.11).
 *
 * ── Связь тура с местом — только записанная ───────────────────────────────
 *
 *   - место — главное место тура (`operator_tours.main_place_id`);
 *   - место — ТОЧКА ПУТИ (`link_kind = 'waypoint'`) маршрута, на который
 *     записан тур (`operator_tours.route_id`), и у тура НЕТ другого главного
 *     места: тур с главным местом снимает его, и его кадр под именем соседней
 *     точки пути был бы подменой места.
 * Связь «рядом» и неразмеченная не годятся; по похожести названий ничего не
 * подбирается.
 *
 * ── Какой снимок ──────────────────────────────────────────────────────────
 *
 * Правило общее с маршрутами (lib/routes/tour-photos): тур на витрине, автор
 * — запись `gallery_credits`, иначе имя партнёра со ссылкой на его страницу;
 * от партнёра — один снимок, партнёры по алфавиту, без рейтингов и оплаты.
 *
 * «Без собственного фото» — ни показываемого главного кадра, ни кадра
 * галереи (shownPhotoSql / galleryShownSql), ни своего адреса в places.images.
 *
 * Сторож: tests/unit/place-tour-photos.test.ts.
 */
import { shownPhotoSql } from '@/lib/images/origin';
import { galleryShownSql } from '@/lib/places/gallery-shown';
import {
  CREDITED_FIRST, TOUR_PHOTO_AUTHOR_SQL, TOUR_PHOTOS_LIMIT, tourPhotoAllowedSql, toRouteTourPhotos,
  type RouteTourPhoto, type TourPhotoRow,
} from '@/lib/routes/tour-photos';

/** Связи «тур — место»: строки (tour_id, pos). `placeIdExpr` — places.id. */
export function placeTourLinksSql(placeIdExpr: string): string {
  return `(
      SELECT ot_m.id AS tour_id, 0 AS pos
        FROM operator_tours ot_m
       WHERE ot_m.main_place_id = (${placeIdExpr})::text
      UNION ALL
      SELECT ot_r.id, 1 + wpt_r.position
        FROM route_waypoints wpt_r
        JOIN kamchatka_routes kr_r ON kr_r.id = wpt_r.route_id
         AND kr_r.merged_into_id IS NULL AND kr_r.is_visible IS NOT FALSE
        JOIN operator_tours ot_r ON ot_r.route_id::text = kr_r.id::text
       WHERE wpt_r.place_id::text = (${placeIdExpr})::text
         AND COALESCE(to_jsonb(wpt_r)->>'link_kind', 'unknown') = 'waypoint'
         AND NULLIF(btrim(ot_r.main_place_id), '') IS NULL
    )`;
}

/** $1 — places.id места (текстом). */
export const PLACE_TOUR_PHOTOS_SQL = `
  WITH shots AS (
    SELECT DISTINCT ON (pa.id)
           pa.id::text AS partner_id, pa.name AS partner_name, pa.slug AS partner_slug,
           pa.is_public AS partner_public,
           ot.title AS tour_title, ot.slug AS tour_slug, NULL::text AS place_name,
           btrim(x.url) AS url, ${TOUR_PHOTO_AUTHOR_SQL} AS author
      FROM ${placeTourLinksSql('$1')} l
      JOIN operator_tours ot ON ot.id = l.tour_id
      JOIN partners pa ON pa.id = ot.operator_id
      CROSS JOIN LATERAL unnest(ot.photos) WITH ORDINALITY AS x(url, n)
     WHERE ${tourPhotoAllowedSql()}
     ORDER BY pa.id, ${CREDITED_FIRST}, l.pos, ot.id, x.n
  )
  SELECT * FROM shots ORDER BY partner_name, partner_id
  LIMIT ${TOUR_PHOTOS_LIMIT}`;

/**
 * Обложка карточки места в списке /places — снимок тура, когда своего кадра
 * нет ни главного, ни в галерее. Один на место: первый партнёр по алфавиту.
 * `$1` — id карточек каталога (places.ark_id), текстом.
 */
export const PLACE_CARD_TOUR_PHOTOS_SQL = `
  SELECT DISTINCT ON (c.aid)
         c.aid AS place_view_id,
         pa.name AS partner_name, pa.slug AS partner_slug, pa.is_public AS partner_public,
         ot.title AS tour_title, ot.slug AS tour_slug, p.name AS place_name,
         btrim(x.url) AS url, ${TOUR_PHOTO_AUTHOR_SQL} AS author
    FROM unnest($1::text[]) AS c(aid)
    JOIN places p ON p.ark_id::text = c.aid AND p.merged_into_id IS NULL
    CROSS JOIN LATERAL ${placeTourLinksSql('p.id')} l
    JOIN operator_tours ot ON ot.id = l.tour_id
    JOIN partners pa ON pa.id = ot.operator_id
    CROSS JOIN LATERAL unnest(ot.photos) WITH ORDINALITY AS x(url, n)
   WHERE ${tourPhotoAllowedSql()}
     AND NOT EXISTS (SELECT 1 FROM ai_route_images ai WHERE ai.route_id = p.ark_id AND ${shownPhotoSql('ai.model')})
     AND NOT EXISTS (SELECT 1 FROM place_gallery_photos g WHERE g.ark_id = p.ark_id AND ${galleryShownSql('g')})
   ORDER BY c.aid, pa.name, pa.id, ${CREDITED_FIRST}, l.pos, ot.id, x.n`;

type FeedOpts = { feedSlugs?: ReadonlySet<string>; feedEnabled?: boolean };

function logFail(what: string, n: number, err: unknown): void {
  const code = (err as { code?: unknown })?.code;
  console.error(`[place-tour-photos] ${what}`, {
    n,
    sqlstate: typeof code === 'string' ? code.slice(0, 10) : null,
    message: (err instanceof Error ? err.message : String(err)).slice(0, 200),
  });
}

/** Снимки туров для страницы места. Сбой — пустой список: место остаётся как было. */
export async function loadPlaceTourPhotos(placeId: string, opts: FeedOpts = {}): Promise<RouteTourPhoto[]> {
  try {
    const { pool } = await import('@/lib/db-pool');
    const { rows } = await pool.query<TourPhotoRow>(PLACE_TOUR_PHOTOS_SQL, [placeId]);
    return toRouteTourPhotos(rows, opts);
  } catch (err) {
    logFail('снимки туров места не прочитаны', 1, err);
    return [];
  }
}

/** Обложки карточек мест одним запросом. Сбой — пустая карта. */
export async function loadPlaceCardTourPhotos(placeViewIds: string[], opts: FeedOpts = {}): Promise<Map<string, RouteTourPhoto>> {
  const photos = new Map<string, RouteTourPhoto>();
  if (placeViewIds.length === 0) return photos;
  try {
    const { pool } = await import('@/lib/db-pool');
    const { rows } = await pool.query<TourPhotoRow & { place_view_id: string }>(PLACE_CARD_TOUR_PHOTOS_SQL, [placeViewIds]);
    for (const r of rows) {
      const [p] = toRouteTourPhotos([r], opts);
      if (p) photos.set(String(r.place_view_id), p);
    }
  } catch (err) {
    logFail('обложки карточек мест не прочитаны', placeViewIds.length, err);
  }
  return photos;
}
