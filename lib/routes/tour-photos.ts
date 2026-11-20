/**
 * Снимки туров на карточке маршрута — когда ни своих кадров, ни кадров точек
 * пути у маршрута нет (владелец 21.11: «нет фото Ганальские востряки — нужно
 * ставить из туров, но чтоб по подписи можно было перейти на страницу
 * владельца фото»).
 *
 * ── Связь тура с маршрутом — только записанная ────────────────────────────
 *
 * Две связи, обе явные, те же, что у блока «Туры к этому месту»
 * (lib/places/place-tours):
 *   - тур записан на этот маршрут (`operator_tours.route_id`);
 *   - главное место тура (`operator_tours.main_place_id`) — ТОЧКА ПУТИ
 *     маршрута (`link_kind = 'waypoint'`). Связь «рядом» и неразмеченная не
 *     годятся: место в 15 км от центра — не вид этого пути (§4.1).
 * По похожести названий ничего не подбирается: «Гора Юрчик» под
 * Петропавловском и вершина Юрчик в Ганальских Востряках — разные горы.
 *
 * ── Какой снимок можно ставить ────────────────────────────────────────────
 *
 *   - тур на витрине (`publicTourSql`);
 *   - РАЗРЕШЕНИЕ: у партнёра действующее согласие той версии, что называет
 *     снимки на карточках мест и маршрутов (`partnerPlaceCardsConsentSql`,
 *     PLACE_CARDS_CONSENT_FROM). Своей колонки лицензии у снимков тура нет —
 *     лицензией служит подписанное согласие. Подпись прежней версии называет
 *     только «блоки туров», и снимок маршрута по ней не ставится — ровно как
 *     с галереей мест (1431, 1436);
 *   - АВТОР известен: снимок записан в `partners.gallery_credits` (адрес →
 *     автор). Нет записи — снимка нет: подписать кадр именем оператора по
 *     умолчанию значило бы утверждать авторство, которого никто не записывал
 *     (lib/tours/photo-credits);
 *   - от каждого партнёра — один снимок (первый подписанный по порядку тура),
 *     партнёры — по алфавиту имени: никаких предпочтений (§0).
 *
 * Сторож: tests/unit/route-tour-photos.test.tsx.
 */
import { publicTourSql } from '@/lib/tours/public-visibility';
import { partnerPlaceCardsConsentSql } from '@/lib/places/gallery-shown';
import { authorFeedSlug, photoCreditFor, type PhotoCredit } from '@/lib/media/author-credit';

export const TOUR_PHOTOS_LIMIT = 6;

/**
 * Связи «тур — маршрут»: строки (tour_id, place_name, pos). `routeIdExpr` —
 * выражение с kamchatka_routes.id (параметр или колонка внешнего запроса).
 */
export function routeTourLinksSql(routeIdExpr: string): string {
  return `(
      SELECT ot_r.id AS tour_id, NULL::text AS place_name, 0 AS pos
        FROM operator_tours ot_r
       WHERE ot_r.route_id::text = (${routeIdExpr})::text
      UNION ALL
      SELECT ot_m.id, p_m.name, rw_m.position + 1
        FROM route_waypoints rw_m
        JOIN places p_m ON p_m.id::text = rw_m.place_id::text
        JOIN operator_tours ot_m ON ot_m.main_place_id = p_m.id::text
       WHERE rw_m.route_id::text = (${routeIdExpr})::text
         AND COALESCE(to_jsonb(rw_m)->>'link_kind', 'unknown') = 'waypoint'
         AND p_m.is_visible IS NOT FALSE
         AND p_m.merged_into_id IS NULL
    )`;
}

/** Условие «снимок тура можно ставить на маршрут»; `ot` — тур, `pa` — партнёр, `x.url` — адрес. */
export function tourPhotoAllowedSql(): string {
  return `${publicTourSql('ot')}
     AND ${partnerPlaceCardsConsentSql('pa.id')}
     AND NULLIF(btrim(x.url), '') IS NOT NULL
     AND NULLIF(btrim(COALESCE(pa.gallery_credits, '{}'::jsonb)->>x.url), '') IS NOT NULL`;
}

/** $1 — kamchatka_routes.id маршрута. */
export const ROUTE_TOUR_PHOTOS_SQL = `
  WITH shots AS (
    SELECT DISTINCT ON (pa.id)
           pa.id::text AS partner_id, pa.name AS partner_name, pa.slug AS partner_slug,
           pa.is_public AS partner_public,
           ot.id::text AS tour_id, ot.title AS tour_title, ot.slug AS tour_slug,
           l.place_name, btrim(x.url) AS url,
           btrim(pa.gallery_credits->>x.url) AS author
      FROM ${routeTourLinksSql('$1')} l
      JOIN operator_tours ot ON ot.id = l.tour_id
      JOIN partners pa ON pa.id = ot.operator_id
      CROSS JOIN LATERAL unnest(ot.photos) WITH ORDINALITY AS x(url, n)
     WHERE ${tourPhotoAllowedSql()}
     ORDER BY pa.id, l.pos, ot.id, x.n
  )
  SELECT * FROM shots ORDER BY partner_name, partner_id
  LIMIT ${TOUR_PHOTOS_LIMIT}`;

export interface RouteTourPhoto {
  url: string;
  /** Подпись автора со ссылкой (страница партнёра или фотолента). */
  credit: PhotoCredit;
  tourTitle: string;
  tourSlug: string | null;
  /** Место пути, к которому идёт тур; null — тур записан на сам маршрут. */
  placeName: string | null;
}

export interface TourPhotoRow {
  url: unknown; author: unknown; partner_name: unknown; partner_slug: unknown; partner_public: unknown;
  tour_title: unknown; tour_slug: unknown; place_name: unknown;
}

const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Строки базы → снимки. Строка без адреса или без автора отбрасывается и
 * здесь, а не только в SQL: снимок без подписи на карточку не попадает.
 * Ссылка подписи — lib/media/author-credit; `feedSlugs` — авторы с лентой.
 */
export function toRouteTourPhotos(rows: readonly TourPhotoRow[], opts: { feedSlugs?: ReadonlySet<string>; feedEnabled?: boolean } = {}): RouteTourPhoto[] {
  const out: RouteTourPhoto[] = [];
  for (const r of rows) {
    const url = s(r.url);
    const author = s(r.author);
    const partnerName = s(r.partner_name);
    if (!url || !author || !partnerName || out.some((p) => p.url === url)) continue;
    const credit = photoCreditFor({
      author,
      partner: { name: partnerName, slug: s(r.partner_slug), isPublic: r.partner_public === true },
      // Лента — только у автора, чьи снимки в неё прошли (lib/media/author-feed).
      feedEligible: opts.feedSlugs?.has(authorFeedSlug(author) ?? '') ?? false,
      feedEnabled: opts.feedEnabled,
    });
    if (!credit) continue;
    out.push({ url, credit, tourTitle: s(r.tour_title) ?? '', tourSlug: s(r.tour_slug), placeName: s(r.place_name) });
  }
  return out;
}

/**
 * Обложка карточки маршрута в списках (каталог, «Похожие маршруты») — по
 * снимку тура на маршрут без своего кадра и без кадра точки пути. Один
 * снимок на маршрут: первый по алфавиту имени партнёра — так порядок не
 * зависит ни от чего, что партнёр мог бы купить (§0). `$1` — id карточек
 * каталога (COALESCE(ark_id, id) маршрута), текстом.
 */
export const ROUTE_CARD_TOUR_PHOTOS_SQL = `
  SELECT DISTINCT ON (c.rid)
         c.rid AS route_view_id,
         pa.name AS partner_name, pa.slug AS partner_slug, pa.is_public AS partner_public,
         ot.title AS tour_title, ot.slug AS tour_slug, l.place_name,
         btrim(x.url) AS url, btrim(pa.gallery_credits->>x.url) AS author
    FROM unnest($1::text[]) AS c(rid)
    JOIN kamchatka_routes kr ON (kr.id::text = c.rid OR kr.ark_id::text = c.rid) AND kr.merged_into_id IS NULL
    CROSS JOIN LATERAL ${routeTourLinksSql('kr.id')} l
    JOIN operator_tours ot ON ot.id = l.tour_id
    JOIN partners pa ON pa.id = ot.operator_id
    CROSS JOIN LATERAL unnest(ot.photos) WITH ORDINALITY AS x(url, n)
   WHERE ${tourPhotoAllowedSql()}
   ORDER BY c.rid, pa.name, pa.id, l.pos, ot.id, x.n`;

export type RouteCardTourPhotos =
  | { state: 'ok'; photos: Map<string, RouteTourPhoto> }
  | { state: 'failed' };

/** Снимки туров для карточек одним запросом. Сбой — `failed`, карточки остаются как были. */
export async function loadRouteCardTourPhotos(
  routeViewIds: string[],
  opts: { feedSlugs?: ReadonlySet<string>; feedEnabled?: boolean } = {},
): Promise<RouteCardTourPhotos> {
  if (routeViewIds.length === 0) return { state: 'ok', photos: new Map() };
  try {
    const { pool } = await import('@/lib/db-pool');
    const { rows } = await pool.query<TourPhotoRow & { route_view_id: string }>(ROUTE_CARD_TOUR_PHOTOS_SQL, [routeViewIds]);
    const photos = new Map<string, RouteTourPhoto>();
    for (const r of rows) {
      const [p] = toRouteTourPhotos([r], opts);
      if (p) photos.set(String(r.route_view_id), p);
    }
    return { state: 'ok', photos };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[route-tour-photos] снимки туров карточек не прочитаны', {
      routes: routeViewIds.length,
      sqlstate: typeof code === 'string' ? code.slice(0, 10) : null,
      message: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
    return { state: 'failed' };
  }
}
