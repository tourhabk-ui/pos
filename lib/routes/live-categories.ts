/**
 * Живые категории каталога — ссылками со страниц /routes и /places.
 *
 * Обход сайта 01.10 после перелинковки дошёл до 896 страниц из 904, и из
 * восьми недостижимых семь — категории (/routes/eco, /routes/trekking и их
 * зоны): друг на друга они ссылались, а снаружи на них не вёл никто.
 *
 * Правило «живая» то же, что у sitemap (`getCatalogPages`, ≥3 объекта), —
 * ссылка на тонкую категорию вела бы в 404.
 */
import { getCatalogPages } from '@/lib/routes/catalog-sitemap';
import { CATEGORY_PAGES } from '@/lib/routes/category-meta';

export interface CategoryLink {
  slug: string;
  name: string;
}

export async function listLiveCategories(): Promise<CategoryLink[]> {
  const pages = await getCatalogPages();
  return pages
    .filter((p) => !p.path.includes('/') && CATEGORY_PAGES[p.path])
    .map((p) => ({ slug: p.path, name: CATEGORY_PAGES[p.path].name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
