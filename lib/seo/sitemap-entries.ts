/**
 * Сборщик записей sitemap. Жил в app/sitemap.ts (метадата-роут) — и Next
 * пререндерил его НА СБОРКЕ, где БД на Timeweb недоступна по построению
 * (Docker-билд без DATABASE_URL): все динамические секции (туры, места,
 * маршруты) молча пустели, sitemap всегда был «тонкий ~46 URL» (аудит
 * «как ИИ видят Ведар», 08.08 — 0 карточек туров при живом llms.txt,
 * который как route-handler исполняется на запросе). Теперь XML отдаёт
 * app/sitemap.xml/route.ts с force-dynamic — тем же паттерном, что llms.txt.
 */
import { tourPath } from '@/lib/tours/tour-url';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { MetadataRoute } from 'next';
import { pool } from '@/lib/db-pool';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { getCatalogPages } from '@/lib/routes/catalog-sitemap';
import { PLAN_PRESETS, planLastModified, plansHubLastModified } from '@/lib/plans/presets';
import { NOT_MERGED } from '@/lib/places/aliases';
import { FISH_SPECIES } from '@/lib/fish-species';
import { CHRONICLE_ARTICLES } from '@/lib/chronicle/articles';

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

// Дата последнего значимого обновления для стабильных страниц
// (избегаем new Date() который меняется при каждом деплое)
const STABLE = new Date('2026-06-01');
const RECENT  = new Date('2026-06-10');

// Приоритет страницы по типу локации
const LOCATION_PRIORITY: Record<string, number> = {
  volcano:    0.8,
  geyser:     0.8,
  hot_spring: 0.75,
  historical: 0.85,
  museum:     0.8,
  forest:     0.75,
  lake:       0.7,
  mountain:   0.7,
  bay:        0.65,
  river:      0.65,
  viewpoint:  0.65,
  waterfall:  0.65,
  beach:      0.65,
  rock:       0.6,
  cape:       0.6,
  island:     0.6,
};

/**
 * Записи sitemap и список секций, которые не удалось прочитать. Секция при
 * отказе базы выпадает, а sitemap остаётся ответом 200 — поэтому вызывающий
 * обязан знать, что ответ неполон: урезанный sitemap нельзя кэшировать
 * (с 29.09 он отдаётся с собственным Cache-Control, а не с общим no-store).
 */
export async function collectSitemapEntriesWithStatus(): Promise<{ entries: MetadataRoute.Sitemap; degraded: string[] }> {
  const degraded: string[] = [];
  /** Отказ секции: в лог имя и причину, в список — имя (§4.0: «не смог» ≠ «пусто»). */
  const fail = (section: string, e: unknown) => {
    degraded.push(section);
    console.error('[sitemap] секция не прочитана:', section, e instanceof Error ? e.message : e);
  };
  // Статические страницы
  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE,                            lastModified: new Date(),  changeFrequency: 'hourly',  priority: 1.0 },
    { url: `${BASE}/places`,               lastModified: new Date(),  changeFrequency: 'daily',   priority: 0.9 },
    { url: `${BASE}/routes`,               lastModified: new Date(),  changeFrequency: 'daily',   priority: 0.9 },
    { url: `${BASE}/map`,                  lastModified: STABLE,      changeFrequency: 'daily',   priority: 0.85 },
    { url: `${BASE}/safety`,               lastModified: new Date(),  changeFrequency: 'daily',   priority: 0.9 },
    { url: `${BASE}/safety/incidents`,     lastModified: new Date(),  changeFrequency: 'daily',   priority: 0.8 },
    { url: `${BASE}/safety/offline`,       lastModified: STABLE,      changeFrequency: 'monthly', priority: 0.7 },
    // Safety-кластер — уникальный контент ниши (аудит 01.08): регистрация
    // МЧС, связь в поле, правила природы. Страницы существовали, но в
    // sitemap не попали и для поиска не существовали.
    { url: `${BASE}/register`,             lastModified: STABLE,      changeFrequency: 'monthly', priority: 0.85 },
    { url: `${BASE}/safety/communication`, lastModified: new Date('2026-07-31'), changeFrequency: 'monthly', priority: 0.75 },
    // Памятка перед поездкой (30.09): факты — импортом из справочников МЧС, парка, SOS.
    { url: `${BASE}/prepare`,             lastModified: new Date('2026-09-30'), changeFrequency: 'monthly', priority: 0.8 },
    // Сводка дня (аудит 01.10): живая, на неё ведут двадцать три страницы, а в
    // sitemap её не было. Собирается на каждый запрос (force-dynamic), поэтому
    // дата — сегодняшняя. /emergency сюда НЕ внесена намеренно: сторож
    // mobile-two-taps требует у каждой страницы sitemap ссылку в меню, а
    // страница SOS открывается кнопкой в шапке — вторая дорога к тому же
    // действию расходилась бы с ней поведением (§2, #887).
    { url: `${BASE}/svodka`,               lastModified: new Date(),  changeFrequency: 'daily',   priority: 0.85 },
    { url: `${BASE}/eco`,                  lastModified: new Date('2026-08-01'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${BASE}/planner`,              lastModified: STABLE,      changeFrequency: 'weekly',  priority: 0.8 },
    // Человекочитаемый первоисточник о MCP-сервере: поисковые AI-ответы читают
    // HTML, а не JSON-манифест (диагноз 15.08 — Алиса галлюцинировала «MCP нет»).
    { url: `${BASE}/mcp`,                  lastModified: new Date('2026-08-15'), changeFrequency: 'monthly', priority: 0.7 },
    // Программатик-страницы готовых планов («Мой план 2.0», A-1): пресеты из
    // lib/plans/presets — единственный источник, sitemap не разъезжается с роутом.
    // Дата — ревизия текста плана (кластер или общая PLANS_TEXT_REVISION), а не
    // STABLE: константа июня говорила поисковику «не менялось четыре месяца».
    { url: `${BASE}/plans`,                lastModified: plansHubLastModified(), changeFrequency: 'weekly', priority: 0.85 },
    ...PLAN_PRESETS.map((p) => ({
      url: `${BASE}/plans/${p.slug}`, lastModified: planLastModified(p), changeFrequency: 'weekly' as const, priority: 0.8,
    })),
    { url: `${BASE}/planning`,             lastModified: STABLE,      changeFrequency: 'weekly',  priority: 0.75 },
    { url: `${BASE}/catalog`,              lastModified: new Date(),  changeFrequency: 'daily',   priority: 0.85 },
    // Посадочная «Рыбалка» из шапки сайта (открыта для индекса 29.09) и
    // справочник рыб — страницы были, в sitemap их не было (аудит SEO 29.09, Н9).
    { url: `${BASE}/hub/fishing`,          lastModified: new Date(),  changeFrequency: 'daily',   priority: 0.85 },
    { url: `${BASE}/fish`,                 lastModified: STABLE,      changeFrequency: 'monthly', priority: 0.7 },
    ...FISH_SPECIES.map((f) => ({
      url: `${BASE}/fish/${f.id}`, lastModified: STABLE, changeFrequency: 'monthly' as const, priority: 0.6,
    })),
    // Летопись Камчатки (03.10): оглавление и статьи; дата — последней сверки с источниками.
    { url: `${BASE}/letopis`,              lastModified: STABLE,      changeFrequency: 'monthly', priority: 0.6 },
    ...CHRONICLE_ARTICLES.map((a) => ({
      url: `${BASE}/letopis/${a.slug}`, lastModified: new Date(a.checkedAt), changeFrequency: 'monthly' as const, priority: 0.6,
    })),
    { url: `${BASE}/accommodations`,       lastModified: RECENT,      changeFrequency: 'daily',   priority: 0.8 },
    // Витрина мест в поездках перевозчиков (схема 926, экран 02.09).
    { url: `${BASE}/transfers`,            lastModified: new Date('2026-09-02'), changeFrequency: 'daily', priority: 0.7 },
    { url: `${BASE}/collections`,          lastModified: STABLE,      changeFrequency: 'weekly',  priority: 0.75 },
    { url: `${BASE}/trending`,             lastModified: new Date(),  changeFrequency: 'daily',   priority: 0.7 },
    { url: `${BASE}/blog`,                 lastModified: new Date(),  changeFrequency: 'daily',   priority: 0.75 },
    // Раздел статей (11.08): двадцать шесть текстов о природе и крае, до
    // этого лежавших в справочнике МАРШРУТОВ как маршруты. Без записи здесь
    // раздел для поиска не существует — ровно так уже пропали туры (08.08).
    { url: `${BASE}/articles`,             lastModified: new Date(),  changeFrequency: 'weekly',  priority: 0.75 },
    { url: `${BASE}/guides`,               lastModified: STABLE,      changeFrequency: 'weekly',  priority: 0.75 },
    { url: `${BASE}/ai-tools`,             lastModified: STABLE,      changeFrequency: 'weekly',  priority: 0.7 },
    { url: `${BASE}/about`,                lastModified: STABLE,      changeFrequency: 'monthly', priority: 0.7 },
    { url: `${BASE}/partners`,             lastModified: STABLE,      changeFrequency: 'monthly', priority: 0.6 },
    { url: `${BASE}/operators`,            lastModified: STABLE,      changeFrequency: 'weekly',  priority: 0.7 },
    { url: `${BASE}/for-operators`,        lastModified: STABLE,      changeFrequency: 'weekly',  priority: 0.65 },
    { url: `${BASE}/faq`,                  lastModified: STABLE,      changeFrequency: 'weekly',  priority: 0.7 },
    { url: `${BASE}/help`,                 lastModified: STABLE,      changeFrequency: 'weekly',  priority: 0.65 },
    { url: `${BASE}/help/tourists`,        lastModified: STABLE,      changeFrequency: 'weekly',  priority: 0.65 },
    { url: `${BASE}/help/operators`,       lastModified: STABLE,      changeFrequency: 'weekly',  priority: 0.6 },
    { url: `${BASE}/help/guides`,          lastModified: STABLE,      changeFrequency: 'weekly',  priority: 0.55 },
    { url: `${BASE}/contact`,              lastModified: STABLE,      changeFrequency: 'monthly', priority: 0.6 },
    { url: `${BASE}/legal/privacy`,        lastModified: STABLE,      changeFrequency: 'monthly', priority: 0.4 },
    { url: `${BASE}/legal/terms`,          lastModified: STABLE,      changeFrequency: 'monthly', priority: 0.4 },
    { url: `${BASE}/legal/offer`,          lastModified: STABLE,      changeFrequency: 'monthly', priority: 0.4 },
    { url: `${BASE}/legal/commission`,     lastModified: STABLE,      changeFrequency: 'monthly', priority: 0.3 },
    { url: `${BASE}/legal/agent-agreement`, lastModified: STABLE,     changeFrequency: 'monthly', priority: 0.3 },
  ];

  // Категории и зонные срезы каталога — динамически, только живые (≥3
  // объектов; тонкие отдают 404 и в sitemap не предлагаются), lastmod из
  // max(updated_at) выборки. БД недоступна → честно без этих страниц,
  // а не статичный список с непроверенным правилом ≥3.
  let categoryPages: MetadataRoute.Sitemap = [];
  try {
    const catalogPages = await getCatalogPages();
    categoryPages = catalogPages.map(p => ({
      url: `${BASE}/routes/${p.path}`,
      lastModified: p.lastModified,
      changeFrequency: 'weekly' as const,
      priority: p.path.includes('/') ? 0.75 : 0.85,
    }));
  } catch (e) {
    fail('каталог', e);
  }

  // Динамические страницы мест (places) — 779 страниц /places/[id]
  let placesPages: MetadataRoute.Sitemap = [];
  try {
    const { rows } = await pool.query<{
      ark_id: string;
      slug: string | null;
      updated_at: Date;
      location_type: string | null;
    }>(`
      SELECT ark_id, slug, updated_at, location_type
      FROM places
      WHERE is_visible = TRUE
        -- Слитое место отвечает 308 на своё основное, которое в sitemap и так
        -- есть: адрес с редиректом sitemap предлагать не должен (Н9).
        AND ${NOT_MERGED('places')}
      ORDER BY updated_at DESC
      LIMIT 2000
    `);
    placesPages = rows.map(row => ({
      url: `${BASE}/places/${row.slug ?? row.ark_id}`,
      lastModified: row.updated_at,
      changeFrequency: 'weekly' as const,
      priority: LOCATION_PRIORITY[row.location_type ?? ''] ?? 0.65,
    }));
  } catch (e) {
    fail('места', e);
  }

  // Страницы статей (11.08). Оглавление без страниц — половина работы:
  // обходчик увидел бы раздел и ни одного текста в нём.
  let articlePages: MetadataRoute.Sitemap = [];
  try {
    const { rows } = await pool.query<{ slug: string; updated_at: Date }>(`
      SELECT slug, updated_at
      FROM articles
      WHERE is_visible = TRUE
      ORDER BY updated_at DESC
      LIMIT 500
    `);
    articlePages = rows.map((row) => ({
      url: `${BASE}/articles/${row.slug}`,
      lastModified: row.updated_at,
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    }));
  } catch (e) {
    // Без статей, а не выдуманный список адресов — но отказ виден.
    fail('статьи', e);
  }

  // Динамические страницы: все видимые маршруты kamchatka_routes
  let routePages: MetadataRoute.Sitemap = [];
  try {
    // id — в пространстве VIEW, COALESCE(ark_id, id): им карточка /routes/[id]
    // ищет маршрут по UUID. Голый kr.id у записи с заполненным ark_id там не
    // находится — адрес маршрута без slug отвечал бы 404 (тот же дефект, что
    // чинили в /api/trending; аудит SEO 29.09, вечер).
    const { rows } = await pool.query<{
      id: string;
      slug: string | null;
      updated_at: Date;
    }>(`
      SELECT COALESCE(kr.ark_id, kr.id) AS id, kr.slug, kr.updated_at
      FROM kamchatka_routes kr
      WHERE (kr.is_visible = TRUE OR kr.is_visible IS NULL)
        AND kr.merged_into_id IS NULL
        -- Двойник места отвечает 308 на /places/{slug} (решение владельца
        -- 29.09): адрес с редиректом sitemap не предлагает.
        AND NOT EXISTS (SELECT 1 FROM places tp WHERE tp.slug = kr.slug AND tp.is_visible = TRUE)
        -- Статья-двойник «kl-*» отвечает 308 на /articles/{slug} (аудит 02.10):
        -- тот же текст лежал под двумя адресами, второй — с разметкой маршрута.
        AND NOT EXISTS (SELECT 1 FROM articles ta WHERE ta.is_visible = TRUE AND kr.slug = 'kl-' || ta.slug)
      ORDER BY kr.updated_at DESC
      LIMIT 2000
    `);

    routePages = rows.map(row => ({
      url: `${BASE}/routes/${row.slug ?? row.id}`,
      lastModified: row.updated_at,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    }));
  } catch (e) {
    fail('маршруты', e);
  }

  // Детальные страницы жилья /accommodations/[id]
  let accommodationPages: MetadataRoute.Sitemap = [];
  try {
    const { rows } = await pool.query<{ id: string; updated_at: Date }>(
      `SELECT id, updated_at FROM accommodations
       WHERE ${publicAccommodationSql('')}
       ORDER BY updated_at DESC LIMIT 500`
    );
    accommodationPages = rows.map(row => ({
      url: `${BASE}/accommodations/${row.id}`,
      lastModified: row.updated_at,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    }));
  } catch (e) {
    fail('жильё', e);
  }

  // Маркетплейс-туры. Раньше фильтр шёл по is_visible — колонке PLACES,
  // которой у operator_tours нет: запрос падал, catch молчал, и в sitemap
  // не было НИ ОДНОЙ карточки тура (аудит «как ИИ видят Ведар», 08.08 —
  // обходчики не находили каталог). Витринные флаги туров — is_active и
  // is_published (837).
  let marketplacePages: MetadataRoute.Sitemap = [];
  try {
    // Тот же предикат и та же связка с партнёром, что у витрины и карточки
    // (lib/tours/public-visibility, tour-detail-query): срез 02.10 — в
    // sitemap 12 туров, на /about 11; тур без строки партнёра карточкой
    // не открывается, и в sitemap ему не место.
    const { rows } = await pool.query<{ id: string; slug: string | null; updated_at: Date }>(
      `SELECT ot.id, ot.slug, ot.updated_at FROM operator_tours ot
       JOIN partners p ON ot.operator_id = p.id
       WHERE ${publicTourSql('ot')}
       ORDER BY ot.updated_at DESC LIMIT 500`
    );
    marketplacePages = rows.map(row => ({
      url: `${BASE}${tourPath(row)}`,
      lastModified: row.updated_at,
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    }));
  } catch (e) {
    // Молчаливый catch прятал сломанный фильтр — теперь причину видно в логах.
    fail('туры', e);
  }

  // Подборки (collections)
  let collectionPages: MetadataRoute.Sitemap = [];
  try {
    const { rows } = await pool.query<{ slug: string; updated_at: Date }>(
      `SELECT slug, updated_at FROM collections
       WHERE is_public = true
       ORDER BY updated_at DESC LIMIT 200`
    );
    collectionPages = rows.map(row => ({
      url: `${BASE}/collections/${row.slug}`,
      lastModified: row.updated_at,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    }));
  } catch (e) {
    // Молчал годами: колонка называлась is_published, а в таблице is_public —
    // подборки не попадали в sitemap ни разу, и отличить это от «таблицы нет»
    // было нечем.
    fail('подборки', e);
  }

  // Профили операторов /operators/[slug]
  let operatorPages: MetadataRoute.Sitemap = [];
  try {
    const { rows } = await pool.query<{ slug: string; updated_at: Date }>(
      `SELECT slug, updated_at FROM partners
       WHERE category = 'operator' AND slug IS NOT NULL
         -- Страница оператора открывается только при is_public; без этого
         -- условия sitemap раздавал адреса, отвечающие 404 (Н9).
         AND is_public = TRUE
       ORDER BY updated_at DESC LIMIT 200`
    );
    operatorPages = rows.map(row => ({
      url: `${BASE}/operators/${row.slug}`,
      lastModified: row.updated_at,
      changeFrequency: 'weekly' as const,
      priority: 0.65,
    }));
  } catch (e) {
    // То же самое: фильтр стоял по partner_type, которого в partners нет —
    // профили операторов в sitemap не попадали, и отказ был не виден.
    fail('операторы', e);
  }

  // Карточки парков (01.10): с серверной отрисовкой у них есть содержимое —
  // прежде страница собиралась в браузере, и поисковик видел 12–13 слов.
  let parkPages: MetadataRoute.Sitemap = [];
  try {
    const { rows } = await pool.query<{ slug: string; updated_at: Date }>(
      `SELECT slug, updated_at FROM parks
       WHERE is_active = true
       ORDER BY display_name LIMIT 50`
    );
    parkPages = rows.map(row => ({
      url: `${BASE}/park/${row.slug}`,
      lastModified: row.updated_at,
      changeFrequency: 'monthly' as const,
      priority: 0.75,
    }));
  } catch (e) {
    fail('парки', e);
  }

  // Пустой раздел жилья — тонкая страница с обещанием «реальных цен»: пока нет
  // ни одного опубликованного объекта, в sitemap её не предлагаем (Н9).
  const staticLive = accommodationPages.length > 0
    ? staticPages
    : staticPages.filter((p) => p.url !== `${BASE}/accommodations`);

  // Страница-список меняется, когда меняется её содержимое. `new Date()` у
  // /places, /routes, /catalog говорил «изменено сейчас» на каждом запросе
  // sitemap — и поисковик учится не верить lastmod сайта целиком (аудит
  // 01.10). Секция не прочиталась — у списка остаётся прежняя дата.
  const listOf: Array<[string, MetadataRoute.Sitemap]> = [
    [`${BASE}/places`, placesPages],
    [`${BASE}/routes`, routePages],
    [`${BASE}/catalog`, marketplacePages],
    [`${BASE}/hub/fishing`, marketplacePages],
    [`${BASE}/accommodations`, accommodationPages],
    [`${BASE}/collections`, collectionPages],
    [`${BASE}/operators`, operatorPages],
  ];
  for (const [url, section] of listOf) {
    const at = latestModified(section);
    const page = staticLive.find((e) => e.url === url);
    if (at && page) page.lastModified = at;
  }

  const entries: MetadataRoute.Sitemap = [
    ...staticLive,
    ...categoryPages,
    ...placesPages,
    ...articlePages,
    ...routePages,
    ...accommodationPages,
    ...marketplacePages,
    ...collectionPages,
    ...operatorPages,
    ...parkPages,
  ];
  return { entries, degraded };
}


/** Только записи — для IndexNow bulk, которому полнота не нужна для ответа. */
export async function collectSitemapEntries(): Promise<MetadataRoute.Sitemap> {
  return (await collectSitemapEntriesWithStatus()).entries;
}

/** Самая поздняя дата изменения в секции; `null` — дат нет. */
export function latestModified(section: MetadataRoute.Sitemap): Date | null {
  let max: number | null = null;
  for (const e of section) {
    if (e.lastModified == null) continue;
    const t = new Date(e.lastModified).getTime();
    if (!Number.isNaN(t) && (max === null || t > max)) max = t;
  }
  return max === null ? null : new Date(max);
}
