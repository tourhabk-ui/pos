/**
 * Фотолента автора — «маленькая инста» (владелец 21.11): сетка снимков
 * одного человека на Ведаре, с каждого снимка — переход на страницу места
 * или маршрута, где он снят.
 *
 * ── Что попадает в ленту ──────────────────────────────────────────────────
 *
 * Решение владельца 20.11 («делай без их согласия»): поле лицензии и
 * согласие партнёра НЕ требуются (до него — требовались, #3618). Попадают:
 *   - снимок места (`ai_route_images`, `place_gallery_photos`), который
 *     карточка показывает (shownPhotoSql / galleryShownSql), с автором; без
 *     внешнего источника (`source_url`) и не с Викисклада: имя автора там —
 *     имя учётной записи, а не человек на Ведаре, и его подпись ведёт, как и
 *     прежде, на страницу файла. Лицензия, если записана, стоит под снимком;
 *   - снимок тура, записанный за человеком (`partners.gallery_credits`), а
 *     не за самим партнёром, — только если тур записан на место или маршрут:
 *     снимку без места перейти некуда.
 * Подпись «владелец платформы» — не имя, ленты у неё нет.
 * Автор, чьё имя совпадает с именем партнёра, ленты не получает: его
 * подпись ведёт на страницу партнёра (lib/media/author-credit).
 *
 * ── Чего в ленте нет ──────────────────────────────────────────────────────
 *
 * Никаких данных о человеке, кроме имени, как оно записано в подписи: ни
 * контактов, ни учётной записи, ни числа «подписчиков». Адрес — транслит
 * имени. Порядок — по месту и времени записи, не по «популярности». Страница
 * закрыта от индекса (`noindex, follow`): лента собирает имя человека в
 * отдельную страницу, и поисковику она не нужна, чтобы найти сами места.
 * Флаг `AUTHOR_PHOTO_FEED=off` выключает ленту целиком (404, подписи —
 * текстом).
 *
 * Сторожа: tests/unit/route-tour-photos.test.tsx, tests/integration/route-tour-photos.pg.test.ts.
 */
import { unstable_cache } from 'next/cache';
import { pool } from '@/lib/db-pool';
import { shownPhotoSql } from '@/lib/images/origin';
import { galleryShownSql } from '@/lib/places/gallery-shown';
import { routeSlugPath } from '@/lib/routes/url-slug';
import { tourPhotoAllowedSql } from '@/lib/routes/tour-photos';
import { authorFeedSlug } from '@/lib/media/author-credit';
import { logText } from '@/lib/log/log-text';

export const AUTHOR_FEED_MAX = 600;

/** Имя совпадает с именем какого-либо партнёра — у такого автора ленты нет. */
const NOT_PARTNER = (expr: string) =>
  `NOT EXISTS (SELECT 1 FROM partners pz WHERE lower(btrim(pz.name)) = lower(btrim(${expr})))`;

/**
 * Все снимки, годные в ленты, — одним запросом на всех авторов. Колонки:
 * author, url, alt (название места или маршрута), href, license, created.
 */
export const AUTHOR_FEED_SQL = `
  SELECT * FROM (
    SELECT btrim(ai.author) AS author,
           '/api/images/route/' || p.ark_id || '?size=card' AS url,
           p.name AS alt,
           '/places/' || COALESCE(p.slug, p.ark_id::text) AS href,
           NULLIF(btrim(ai.license), '') AS license, ai.created_at AS created
      FROM ai_route_images ai
      JOIN places p ON p.ark_id = ai.route_id
     WHERE ${shownPhotoSql('ai.model')}
       AND p.is_visible IS NOT FALSE AND p.merged_into_id IS NULL
       AND COALESCE(ai.model, '') NOT IN ('wikimedia', 'wikimedia-commons')
       AND NULLIF(btrim(ai.author), '') IS NOT NULL
       AND NULLIF(btrim(ai.source_url), '') IS NULL
       AND ${NOT_PARTNER('ai.author')}
    UNION ALL
    SELECT btrim(g.author),
           '/api/images/place-gallery/' || g.ark_id || '/' || g.position || '?v=' || EXTRACT(EPOCH FROM g.created_at)::bigint,
           p.name,
           '/places/' || COALESCE(p.slug, p.ark_id::text),
           NULLIF(btrim(g.license), ''), g.created_at
      FROM place_gallery_photos g
      JOIN places p ON p.ark_id = g.ark_id
     WHERE ${galleryShownSql('g')}
       AND g.partner_id IS NULL
       AND p.is_visible IS NOT FALSE AND p.merged_into_id IS NULL
       AND NULLIF(btrim(g.author), '') IS NOT NULL
       AND NULLIF(btrim(g.source_url), '') IS NULL
       AND ${NOT_PARTNER('g.author')}
    UNION ALL
    SELECT btrim(pa.gallery_credits->>x.url),
           btrim(x.url),
           COALESCE(pm.name, kr.title),
           CASE WHEN pm.id IS NOT NULL THEN '/places/' || COALESCE(pm.slug, pm.ark_id::text)
                ELSE 'route:' || COALESCE(kr.slug, COALESCE(kr.ark_id, kr.id)::text) END,
           'снимок с тура партнёра «' || pa.name || '»',
           ot.updated_at
      FROM operator_tours ot
      JOIN partners pa ON pa.id = ot.operator_id
      CROSS JOIN LATERAL unnest(ot.photos) WITH ORDINALITY AS x(url, n)
      LEFT JOIN places pm ON pm.id = ot.main_place_id
                         AND pm.is_visible IS NOT FALSE AND pm.merged_into_id IS NULL
      LEFT JOIN kamchatka_routes kr ON kr.id = ot.route_id AND kr.merged_into_id IS NULL
     WHERE ${tourPhotoAllowedSql()}
       AND NULLIF(btrim(pa.gallery_credits->>x.url), '') IS NOT NULL
       AND (pm.id IS NOT NULL OR kr.id IS NOT NULL)
       AND lower(btrim(pa.gallery_credits->>x.url)) <> lower(btrim(pa.name))
       AND left(lower(btrim(pa.gallery_credits->>x.url)), length(btrim(pa.name)) + 2) <> lower(btrim(pa.name)) || '. '
       AND ${NOT_PARTNER("pa.gallery_credits->>x.url")}
  ) feed
  ORDER BY author, alt, created
  LIMIT ${AUTHOR_FEED_MAX}`;

export interface FeedPhoto {
  url: string;
  /** Название места или маршрута — и alt, и подпись. */
  alt: string;
  /** Страница места или маршрута. */
  href: string;
  /** Лицензия словами, как записана; null — не записана. */
  license: string | null;
}

export interface AuthorFeed {
  slug: string;
  /** Имя — как в подписи. */
  name: string;
  photos: FeedPhoto[];
}

export interface FeedRow { author: unknown; url: unknown; alt: unknown; href: unknown; license: unknown }

/** Подписи, которые не имя человека: ленты у них нет. */
const NOT_A_NAME = new Set(['владелец платформы']);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function hrefOf(raw: string): string {
  return raw.startsWith('route:') ? routeSlugPath(raw.slice('route:'.length)) : raw;
}

/** Строки → ленты по slug. Строка без автора или адреса отбрасывается; лицензия не обязательна. */
export function groupFeeds(rows: readonly FeedRow[]): Map<string, AuthorFeed> {
  const feeds = new Map<string, AuthorFeed>();
  for (const r of rows) {
    const name = str(r.author);
    const url = str(r.url);
    const license = str(r.license);
    const href = str(r.href);
    if (!name || !url || !href) continue;
    if (NOT_A_NAME.has(name.toLocaleLowerCase('ru'))) continue;
    const slug = authorFeedSlug(name);
    if (!slug) continue;
    const feed = feeds.get(slug) ?? { slug, name, photos: [] };
    if (feed.photos.some((p) => p.url === url)) continue;
    feed.photos.push({ url, alt: str(r.alt) ?? name, href: hrefOf(href), license: license ?? null });
    feeds.set(slug, feed);
  }
  return feeds;
}

const loadAll = unstable_cache(
  async (): Promise<AuthorFeed[]> => {
    const { rows } = await pool.query<FeedRow & Record<string, unknown>>(AUTHOR_FEED_SQL);
    return [...groupFeeds(rows).values()];
  },
  ['author-photo-feeds-v1'],
  { revalidate: 600 },
);

export type AuthorFeedResult = { state: 'ok'; feed: AuthorFeed } | { state: 'none' } | { state: 'failed' };

/** Лента по slug. Нет снимков — `none` (страница 404); отказ БД — `failed`. */
export async function loadAuthorFeed(slug: string): Promise<AuthorFeedResult> {
  try {
    const feed = (await loadAll()).find((f) => f.slug === slug);
    return feed && feed.photos.length > 0 ? { state: 'ok', feed } : { state: 'none' };
  } catch (err) {
    console.error('[author-feed] ленты не прочитаны', { slug: logText(slug, 80), message: logText(err instanceof Error ? err.message : err, 200) });
    return { state: 'failed' };
  }
}

/** Имена авторов, у которых есть лента, — для ссылок подписей. Отказ — пусто. */
export async function loadFeedAuthorSlugs(): Promise<Set<string>> {
  try {
    return new Set((await loadAll()).map((f) => f.slug));
  } catch {
    return new Set();
  }
}
