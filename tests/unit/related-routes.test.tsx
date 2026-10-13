/**
 * «Похожие маршруты» — с сервера и по кольцу (перепись sitemap 13.10, прогон 6).
 *
 * До правки блок собирался в браузере после загрузки, и в первом HTML
 * карточки маршрута не было ни одной ссылки на другие маршруты; набор к тому
 * же был один на всё занятие. Перепись насчитала 95 маршрутов без единой
 * входящей ссылки со страниц sitemap.
 *
 * Сторож держит три вещи вызовом и рендером:
 *  - правило соседей: каждый маршрут группы из n ≥ 2 получает ровно
 *    min(K, n − 1) входящих — свойство правила, а не данных;
 *  - загрузчик: одна выборка маршрутов каталога по названию, группа — то же
 *    занятие (без занятия — свои), места в кольцо не попадают, линия маршрута
 *    в кэш не уходит;
 *  - блок: ссылки на соседей рендерятся из пропсов, без запроса из браузера.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { CatalogItem } from '@/lib/routes/catalog-query';

const queryCatalog = vi.fn();
vi.mock('next/cache', () => ({ unstable_cache: <T,>(fn: T) => fn }));
vi.mock('@/lib/routes/catalog-query', async (orig) => ({
  ...(await orig<typeof import('@/lib/routes/catalog-query')>()),
  queryCatalog: (...a: unknown[]) => queryCatalog(...a),
}));
vi.mock('@/hooks/use-wishlist', () => ({
  useWishlist: () => ({ on: false, busy: false, localOnly: false, toggle: () => {} }),
  wishlistLabel: () => 'В избранное',
  WISHLIST_LOCAL_ONLY_HINT: '',
}));

import { ringNeighbors, relatedRoutesFor, RELATED_K } from '@/lib/routes/related';
import { RelatedRoutes } from '@/components/routes/RelatedRoutes';

afterEach(cleanup);

describe('ringNeighbors — K следующих по кольцу', () => {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  const G = ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id }));

  it('следующие за собой, с переходом через конец, без себя', () => {
    expect(ids(ringNeighbors(G, 'C', 4))).toEqual(['D', 'E', 'A', 'B']);
    expect(ids(ringNeighbors(G, 'E', 2))).toEqual(['A', 'B']);
  });

  it('группа меньше K — все остальные; один в группе — никого', () => {
    expect(ids(ringNeighbors(G.slice(0, 3), 'A', 4))).toEqual(['B', 'C']);
    expect(ringNeighbors([{ id: 'A' }], 'A', 4)).toEqual([]);
  });

  it('себя в группе нет — первые K (показать можно, гарантии нет)', () => {
    expect(ids(ringNeighbors(G, 'Z', 2))).toEqual(['A', 'B']);
  });

  it('у каждого члена группы ровно min(K, n − 1) входящих', () => {
    for (let n = 2; n <= 12; n += 1) {
      for (let k = 1; k <= 5; k += 1) {
        const g = Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));
        const inbound = new Map(g.map((x) => [x.id, 0]));
        for (const x of g) for (const y of ringNeighbors(g, x.id, k)) inbound.set(y.id, inbound.get(y.id)! + 1);
        for (const [id, c] of inbound) expect({ n, k, id, c }).toEqual({ n, k, id, c: Math.min(k, n - 1) });
      }
    }
  });
});

function item(id: string, activityType: string | null, kind: CatalogItem['kind'] = 'route'): CatalogItem {
  return {
    id, slug: id, urlSlug: `slug-${id}`, kind, category: 'trekking', locationType: null, activityType,
    title: `Маршрут ${id}`, description: 'х'.repeat(1200), lat: null, lng: null, sourceUrl: null, sourceName: null,
    priceFrom: null, season: null, difficulty: null, durationDays: null, bestMonths: null,
    geometry: { type: 'LineString', coordinates: [[158.1, 53.2], [158.2, 53.3]] },
    volcanoStatus: null,
  } as CatalogItem;
}

describe('relatedRoutesFor — группа того же занятия из одной выборки', () => {
  beforeEach(() => {
    queryCatalog.mockReset();
    queryCatalog.mockResolvedValue({ items: [
      item('A', 'fishing'), item('B', 'fishing'), item('P', 'fishing', 'place'), item('C', 'fishing'),
      item('D', 'trekking'), item('E', 'trekking'),
      item('F', null), item('G', null),
    ], meta: { total: 8, page: 1, limit: 2000, pages: 1 } });
  });

  it('спрашивает каталог один раз: маршруты по названию, все разом', async () => {
    await relatedRoutesFor({ id: 'B', activityType: 'fishing' });
    expect(queryCatalog).toHaveBeenCalledWith(expect.objectContaining({ kind: 'route', sort: 'title', limit: 2000 }));
  });

  it('соседи — из своего занятия, место в кольцо не попадает', async () => {
    const r = await relatedRoutesFor({ id: 'B', activityType: 'fishing' });
    expect(r.map((x) => x.id)).toEqual(['C', 'A']);
  });

  it('без занятия — своя группа, а не весь каталог', async () => {
    const r = await relatedRoutesFor({ id: 'F', activityType: null });
    expect(r.map((x) => x.id)).toEqual(['G']);
  });

  it('линия маршрута и длинное описание в кэш не уходят', async () => {
    const [n] = await relatedRoutesFor({ id: 'D', activityType: 'trekking' });
    expect(n.geometry).toBeNull();
    expect(n.description.length).toBeLessThanOrEqual(300);
    expect(RELATED_K).toBe(4);
  });
});

describe('блок «Похожие маршруты» — ссылки из пропсов', () => {
  const routes = [item('C', 'fishing'), item('A', 'fishing')];

  it('у каждого соседа — ссылка на его карточку; «Все» — на занятие', () => {
    const { container } = render(<RelatedRoutes routes={routes} activityType="fishing" />);
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining(['/routes/slug-C', '/routes/slug-A', '/routes?activity_type=fishing']));
    expect(container.textContent).toContain('Похожие маршруты');
  });

  it('без занятия «Все» ведёт в общий список, а не на пустой фильтр', () => {
    const { container } = render(<RelatedRoutes routes={routes} activityType={null} />);
    const all = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('Все'));
    expect(all?.getAttribute('href')).toBe('/routes');
  });

  it('соседей нет — блока нет', () => {
    const { container } = render(<RelatedRoutes routes={[]} activityType="fishing" />);
    expect(container.textContent).toBe('');
  });
});
