/**
 * Живые категории каталога достижимы по ссылкам (обход vedarai.ru 01.10).
 *
 * После перелинковки обход дошёл до 896 страниц из 904; семь из восьми
 * недостижимых — категории /routes/eco, /routes/trekking и их зоны: друг на
 * друга они ссылались, снаружи — никто. Полоса «Виды» на /routes и /places
 * ведёт на них, а правило «живая» — то же, что у sitemap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { listLiveCategories } from '@/lib/routes/live-categories';
import { getCatalogPages } from '@/lib/routes/catalog-sitemap';

beforeEach(() => query.mockReset());

describe('живые категории', () => {
  it('категории с ≥3 объектами — ссылки; тонкие и неизвестные — нет; зоны — не здесь', async () => {
    query.mockResolvedValue({ rows: [
      { category: 'eco', zone: 'avachinsky', count: '4', last: null },
      { category: 'eco', zone: null, count: '2', last: null },
      { category: 'trekking', zone: null, count: '3', last: null },
      { category: 'vulkani', zone: null, count: '2', last: null },
      { category: 'unknown_slug', zone: null, count: '9', last: null },
    ] });
    expect(await listLiveCategories()).toEqual([
      { slug: 'trekking', name: 'Трекинг' },
      { slug: 'eco', name: 'Экомаршруты' },
    ].sort((a, b) => a.name.localeCompare(b.name, 'ru')));
  });

  it('то же правило, что у sitemap: список — подмножество его категорий', async () => {
    query.mockResolvedValue({ rows: [
      { category: 'eco', zone: null, count: '5', last: null },
      { category: 'rybalka', zone: null, count: '1', last: null },
    ] });
    const sitemapCats = (await getCatalogPages()).filter(p => !p.path.includes('/')).map(p => p.path);
    const linked = (await listLiveCategories()).map(c => c.slug);
    expect(linked).toEqual(sitemapCats);
  });
});

describe('страницы каталога ссылаются на категории', () => {
  it('/routes и /places читают категории на сервере и отдают клиенту', () => {
    for (const f of ['app/routes/(list)/page.tsx', 'app/places/page.tsx']) {
      const src = readFileSync(f, 'utf-8');
      expect(src, f).toMatch(/listLiveCategories\(\)/);
      expect(src, f).toMatch(/initialCategories=\{/);
    }
    expect(readFileSync('app/routes/_RoutesPageClient.tsx', 'utf-8')).toMatch(/<CategoriesStrip categories=\{initialCategories\} \/>/);
  });

  it('полоса ведёт на /routes/<slug>', () => {
    expect(readFileSync('components/routes/CategoriesStrip.tsx', 'utf-8')).toMatch(/href=\{`\/routes\/\$\{c\.slug\}`\}/);
  });
});
