import { MetadataRoute } from 'next';
import { pool } from '@/lib/db-pool';
import { getCatalogPages } from '@/lib/routes/catalog-sitemap';

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

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Статические страницы
  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE,                            lastModified: new Date(),  changeFrequency: 'hourly',  priority: 1.0 },
    { url: `${BASE}/routes`,               lastModified: new Date(),  changeFrequency: 'daily',   priority: 0.9 },
    { url: `${BASE}/map`,                  lastModified: STABLE,      changeFrequency: 'daily',   priority: 0.85 },
    { url: `${BASE}/safety`,               lastModified: new Date(),  changeFrequency: 'daily',   priority: 0.9 },
    { url: `${BASE}/safety/incidents`,     lastModified: new Date(),  changeFrequency: 'daily',   priority: 0.8 },
    { url: `${BASE}/safety/offline`,       lastModified: STABLE,      changeFrequency: 'monthly', priority: 0.7 },
    { url: `${BASE}/planner`,              lastModified: STABLE,      changeFrequency: 'weekly',  priority: 0.8 },
    { url: `${BASE}/planning`,             lastModified: STABLE,      changeFrequency: 'weekly',  priority: 0.75 },
    { url: `${BASE}/catalog`,              lastModified: new Date(),  changeFrequency: 'daily',   priority: 0.85 },
    { url: `${BASE}/accommodations`,       lastModified: RECENT,      changeFrequency: 'daily',   priority: 0.8 },
    { url: `${BASE}/collections`,          lastModified: STABLE,      changeFrequency: 'weekly',  priority: 0.75 },
    { url: `${BASE}/trending`,             lastModified: new Date(),  changeFrequency: 'daily',   priority: 0.7 },
    { url: `${BASE}/blog`,                 lastModified: new Date(),  changeFrequency: 'daily',   priority: 0.75 },
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
  } catch {
    // sitemap без страниц каталога
  }

  // Динамические страницы мест (places) — 779 страниц /places/[id]
  let placesPages: MetadataRoute.Sitemap = [];
  try {
    const { rows } = await pool.query<{
      ark_id: string;
      updated_at: Date;
      location_type: string | null;
    }>(`
      SELECT ark_id, updated_at, location_type
      FROM places
      WHERE is_visible = TRUE
      ORDER BY updated_at DESC
      LIMIT 2000
    `);
    placesPages = rows.map(row => ({
      url: `${BASE}/places/${row.ark_id}`,
      lastModified: row.updated_at,
      changeFrequency: 'weekly' as const,
      priority: LOCATION_PRIORITY[row.location_type ?? ''] ?? 0.65,
    }));
  } catch {
    // Если БД недоступна при сборке — sitemap без страниц мест
  }

  // Динамические страницы: все видимые маршруты kamchatka_routes
  let routePages: MetadataRoute.Sitemap = [];
  try {
    const { rows } = await pool.query<{
      id: string;
      updated_at: Date;
    }>(`
      SELECT id, updated_at
      FROM kamchatka_routes
      WHERE is_visible = TRUE OR is_visible IS NULL
      ORDER BY updated_at DESC
      LIMIT 2000
    `);

    routePages = rows.map(row => ({
      url: `${BASE}/routes/${row.id}`,
      lastModified: row.updated_at,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    }));
  } catch {
    // Если БД недоступна при сборке — sitemap без динамических страниц
  }

  // Маркетплейс-туры
  let marketplacePages: MetadataRoute.Sitemap = [];
  try {
    const { rows } = await pool.query<{ id: string; updated_at: Date }>(
      `SELECT id, updated_at FROM operator_tours
       WHERE deleted_at IS NULL AND is_visible = true
       ORDER BY updated_at DESC LIMIT 500`
    );
    marketplacePages = rows.map(row => ({
      url: `${BASE}/catalog/tours/${row.id}`,
      lastModified: row.updated_at,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    }));
  } catch {
    // fallback
  }

  // Подборки (collections)
  let collectionPages: MetadataRoute.Sitemap = [];
  try {
    const { rows } = await pool.query<{ slug: string; updated_at: Date }>(
      `SELECT slug, updated_at FROM collections
       WHERE is_published = true
       ORDER BY updated_at DESC LIMIT 200`
    );
    collectionPages = rows.map(row => ({
      url: `${BASE}/collections/${row.slug}`,
      lastModified: row.updated_at,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    }));
  } catch {
    // Таблица может отсутствовать
  }

  // Профили операторов /operators/[slug]
  let operatorPages: MetadataRoute.Sitemap = [];
  try {
    const { rows } = await pool.query<{ slug: string; updated_at: Date }>(
      `SELECT slug, updated_at FROM partners
       WHERE partner_type = 'operator' AND slug IS NOT NULL
       ORDER BY updated_at DESC LIMIT 200`
    );
    operatorPages = rows.map(row => ({
      url: `${BASE}/operators/${row.slug}`,
      lastModified: row.updated_at,
      changeFrequency: 'weekly' as const,
      priority: 0.65,
    }));
  } catch {
    // fallback
  }

  return [
    ...staticPages,
    ...categoryPages,
    ...placesPages,
    ...routePages,
    ...marketplacePages,
    ...collectionPages,
    ...operatorPages,
  ];
}

