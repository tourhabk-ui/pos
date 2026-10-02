/**
 * tests/unit/catalog-seo-zones.test.ts
 *
 * Программные SEO-страницы каталога (задача M):
 * - getCatalogPages: в sitemap только категории и зонные срезы с ≥3
 *   объектами, lastmod из max(updated_at), неизвестные категории/зоны
 *   отфильтрованы;
 * - CategoryPage: <3 объектов → notFound (тонкая страница = 404);
 * - зонная страница: несуществующая категория/зона → notFound;
 * - метаданные зонной страницы: canonical на свой URL.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

import { getCatalogPages } from '@/lib/routes/catalog-sitemap';
import { generateMetadata } from '@/app/routes/[id]/[zone]/page';
import CategoryPage from '@/components/routes/CategoryPage';

beforeEach(() => {
  poolQueryMock.mockReset();
});

/** Все href в дереве элементов, без рендера компонентов. */
function collectHrefs(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) collectHrefs(n, acc);
    return acc;
  }
  if (node && typeof node === 'object' && 'props' in node) {
    const props = (node as { props: Record<string, unknown> }).props;
    if (typeof props.href === 'string') acc.push(props.href);
    collectHrefs(props.children, acc);
  }
  return acc;
}

describe('getCatalogPages — правило ≥3 в sitemap', () => {
  it('живые категории и зоны попадают, тонкие и неизвестные — нет', async () => {
    const may = new Date('2026-05-01');
    const jun = new Date('2026-06-15');
    poolQueryMock.mockResolvedValue({
      rows: [
        // vulkani: avachinsky 5 (живой срез), western 2 (тонкий) → категория 7
        { category: 'vulkani', zone: 'avachinsky', count: '5', last: jun },
        { category: 'vulkani', zone: 'western', count: '2', last: may },
        // rybalka: всего 2 → и категория тонкая
        { category: 'rybalka', zone: null, count: '2', last: may },
        // неизвестная категория — фильтруется
        { category: 'unknown_cat', zone: 'avachinsky', count: '10', last: jun },
        // неизвестная зона — в агрегат категории идёт, срезом не становится
        { category: 'vulkani', zone: 'moon', count: '4', last: may },
      ],
    });

    const pages = await getCatalogPages();
    const paths = pages.map(p => p.path).sort();

    expect(paths).toEqual(['vulkani', 'vulkani/avachinsky']);

    const categoryEntry = pages.find(p => p.path === 'vulkani')!;
    expect(categoryEntry.lastModified).toEqual(jun); // max(updated_at)
  });

  it('пустая БД → пустой список, без выдуманных страниц', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    expect(await getCatalogPages()).toEqual([]);
  });
});

describe('CategoryPage — тонкая страница отдаёт 404', () => {
  it('<3 объектов → notFound', async () => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('COUNT(*) AS count') && !sql.includes('GROUP BY')) {
        return Promise.resolve({ rows: [{ count: '2' }] });
      }
      if (sql.includes('GROUP BY zone')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    // notFound() бросает NEXT_NOT_FOUND
    await expect(CategoryPage({ category: 'vulkani' })).rejects.toThrow();
  });

  it('«Другие виды» ссылаются только на живые категории (≥3), тонкая отдала бы 404', async () => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('COUNT(*) AS count') && !sql.includes('GROUP BY')) {
        return Promise.resolve({ rows: [{ count: '5' }] });
      }
      if (sql.includes('GROUP BY category')) {
        return Promise.resolve({
          rows: [
            { category: 'vulkani', count: '5' },
            { category: 'rybalka', count: '3' },
            { category: 'eco', count: '2' },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const hrefs = collectHrefs(await CategoryPage({ category: 'vulkani' }));
    expect(hrefs).toContain('/routes/rybalka');
    expect(hrefs).not.toContain('/routes/eco');
    expect(hrefs).not.toContain('/routes/geyzery'); // в данных нет вовсе
    expect(hrefs).not.toContain('/routes/vulkani'); // себя не повторяет
  });

  it('несуществующая категория → notFound без запросов к БД', async () => {
    await expect(CategoryPage({ category: 'nope' })).rejects.toThrow();
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('несуществующая зона → notFound', async () => {
    await expect(CategoryPage({ category: 'vulkani', zone: 'moon' })).rejects.toThrow();
    expect(poolQueryMock).not.toHaveBeenCalled();
  });
});

describe('зонная страница — метаданные', () => {
  it('canonical указывает на свой URL, title содержит категорию и зону', async () => {
    const meta = await generateMetadata({
      params: Promise.resolve({ id: 'vulkani', zone: 'avachinsky' }),
    });

    expect(meta.alternates?.canonical).toBe('https://vedarai.ru/routes/vulkani/avachinsky');
    expect(String(meta.title)).toContain('Авачинская зона');
    expect(String(meta.title)).toContain('Вулканы');
  });

  it('несуществующая комбинация → заглушка без canonical', async () => {
    const meta = await generateMetadata({
      params: Promise.resolve({ id: 'vulkani', zone: 'moon' }),
    });
    expect(meta.title).toBe('Страница не найдена');
    expect(meta.alternates?.canonical).toBeUndefined();
  });
});
