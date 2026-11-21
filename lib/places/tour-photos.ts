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
import { authorFeedSlug, photoCreditFor } from '@/lib/media/author-credit';
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

/**
 * Обложка плитки места из его же галереи (21.11): кадр партнёра в галерее
 * места (1431/1436) с 21.11 показывается без согласия, а плитка брала только
 * главный кадр — у таких мест страница с фото, а плитка пустая. Первый
 * показываемый кадр по позиции; подпись — партнёр или автор, как на странице.
 * `$1` — places.ark_id карточек, текстом.
 */
export const PLACE_CARD_GALLERY_PHOTOS_SQL = `
  SELECT DISTINCT ON (c.aid)
         c.aid AS place_view_id,
         '/api/images/place-gallery/' || g.ark_id || '/' || g.position
           || '?v=' || EXTRACT(EPOCH FROM g.created_at)::bigint AS url,
         COALESCE(NULLIF(btrim(pa.name), ''), NULLIF(btrim(g.author), '')) AS author,
         COALESCE(pa.name, '') AS partner_name, pa.slug AS partner_slug, pa.is_public AS partner_public,
         NULL::text AS tour_title, NULL::text AS tour_slug, p.name AS place_name
    FROM unnest($1::text[]) AS c(aid)
    JOIN places p ON p.ark_id::text = c.aid AND p.merged_into_id IS NULL
    JOIN place_gallery_photos g ON g.ark_id = p.ark_id AND ${galleryShownSql('g')}
    LEFT JOIN partners pa ON pa.id = g.partner_id
   WHERE NOT EXISTS (SELECT 1 FROM ai_route_images ai WHERE ai.route_id = p.ark_id AND ${shownPhotoSql('ai.model')})
   ORDER BY c.aid, g.position`;

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

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Строка галереи → обложка: подпись — партнёр со ссылкой на его страницу или автор; автора нет — без подписи. */
export function toGalleryCardPhoto(r: TourPhotoRow, opts: FeedOpts = {}): RouteTourPhoto | null {
  const url = str(r.url);
  if (!url) return null;
  const author = str(r.author);
  const partnerName = str(r.partner_name);
  const credit = photoCreditFor({
    author,
    partner: partnerName ? { name: partnerName, slug: str(r.partner_slug), isPublic: r.partner_public === true } : null,
    feedEligible: author ? opts.feedSlugs?.has(authorFeedSlug(author) ?? '') ?? false : false,
    feedEnabled: opts.feedEnabled,
  });
  return { url, credit: credit ?? { name: '', href: null, kind: 'text' }, tourTitle: '', tourSlug: null, placeName: str(r.place_name) };
}

/**
 * Обложки карточек мест одним запросом на источник: сначала свой кадр
 * галереи, у места без него — снимок тура. Сбой — пустая карта.
 */
export async function loadPlaceCardTourPhotos(placeViewIds: string[], opts: FeedOpts = {}): Promise<Map<string, RouteTourPhoto>> {
  const photos = new Map<string, RouteTourPhoto>();
  if (placeViewIds.length === 0) return photos;
  try {
    const { pool } = await import('@/lib/db-pool');
    for (const sql of [PLACE_CARD_GALLERY_PHOTOS_SQL, PLACE_CARD_TOUR_PHOTOS_SQL]) {
      const rest = placeViewIds.filter((id) => !photos.has(id));
      if (rest.length === 0) break;
      const { rows } = await pool.query<TourPhotoRow & { place_view_id: string }>(sql, [rest]);
      for (const r of rows) {
        const p = sql === PLACE_CARD_GALLERY_PHOTOS_SQL ? toGalleryCardPhoto(r, opts) : toRouteTourPhotos([r], opts)[0];
        if (p) photos.set(String(r.place_view_id), p);
      }
    }
  } catch (err) {
    logFail('обложки карточек мест не прочитаны', placeViewIds.length, err);
  }
  return photos;
}
