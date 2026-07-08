/**
 * Динамические SEO-страницы каталога для sitemap (задача M).
 * Правило ≥3 (MIN_ITEMS_FOR_PAGE): категория или зонный срез попадают в
 * sitemap только если страница реально отдаёт ≥3 объектов — тонкие
 * страницы отдают 404 (CategoryPage) и в индекс не предлагаются.
 * lastmod — из max(updated_at) выборки, не выдуманная дата.
 */

import { pool } from '@/lib/db-pool';
import { CATEGORY_SLUGS } from '@/lib/routes/category-meta';
import { ZONE_PAGES, MIN_ITEMS_FOR_PAGE } from '@/lib/routes/zone-meta';

export interface CatalogSitemapEntry {
  /** Путь относительно /routes: 'vulkani' или 'vulkani/avachinsky' */
  path: string;
  /** max(updated_at) выборки; отсутствует, если дат в данных нет — честнее без lastmod, чем с выдуманным */
  lastModified?: Date;
}

export async function getCatalogPages(): Promise<CatalogSitemapEntry[]> {
  const categorySet = new Set<string>(CATEGORY_SLUGS);

  // Источник тот же, что у CategoryPage — счётчики sitemap и страницы
  // обязаны совпадать, иначе правило ≥3 несогласовано. Чтение VIEW
  // agent_route_knowledge здесь — осознанное исключение из запрета
  // CLAUDE.md: категорийные страницы исторически читают этот VIEW
  // (places UNION kamchatka_routes), и sitemap обязан считать по нему же.
  const { rows } = await pool.query<{
    category: string;
    zone: string | null;
    count: string;
    last: Date | null;
  }>(
    `SELECT category, zone, COUNT(*) AS count, MAX(updated_at) AS last
     FROM agent_route_knowledge
     WHERE is_visible = TRUE AND category IS NOT NULL
     GROUP BY category, zone`
  );

  const byCategory = new Map<string, { count: number; last: Date | null }>();
  const entries: CatalogSitemapEntry[] = [];

  for (const row of rows) {
    if (!categorySet.has(row.category)) continue;
    const count = Number(row.count);
    const last = row.last;

    // Агрегат по категории (сумма всех зон и записей без зоны)
    const agg = byCategory.get(row.category) ?? { count: 0, last: null };
    agg.count += count;
    if (last && (!agg.last || last > agg.last)) agg.last = last;
    byCategory.set(row.category, agg);

    // Зонный срез — только известные зоны и только живые (≥3)
    if (row.zone && ZONE_PAGES[row.zone] && count >= MIN_ITEMS_FOR_PAGE) {
      entries.push({ path: `${row.category}/${row.zone}`, ...(last ? { lastModified: last } : {}) });
    }
  }

  for (const [category, agg] of byCategory) {
    if (agg.count >= MIN_ITEMS_FOR_PAGE) {
      entries.push({ path: category, ...(agg.last ? { lastModified: agg.last } : {}) });
    }
  }

  return entries;
}
