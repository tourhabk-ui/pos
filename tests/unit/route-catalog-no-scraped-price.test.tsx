/**
 * У маршрута и места цены нет — она у тура (слово владельца 17.11 «1 да»).
 *
 * Каталог маршрутов показывал «от N ₽» из `payload.price_from`: число скачано
 * со статьи-источника, тура за ним не было, источник не записан (§0, §24).
 * Карточка маршрута это правило держит с 18.07 («Рыболовная база» с «от
 * 18 000 ₽» без единого оффера), а страница категории, запасная карточка
 * каталога, фильтр и сортировка по цене, ответ /api/routes и сообщение
 * Telegram после заявки продолжали брать то же число.
 *
 * Здесь — рендером и вызовом: страница категории с записью, где цена стоит,
 * цены не показывает; запрос каталога её не выбирает, по ней не сортирует и не
 * фильтрует; маршруты оператора называют цену тура, а не записи маршрута.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const poolQueryMock = vi.fn();
const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));
vi.mock('@/lib/database', () => ({ query: (...args: unknown[]) => queryMock(...args) }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/hooks/use-wishlist', () => ({
  useWishlist: () => ({ on: false, busy: false, localOnly: false, error: null, toggle: () => {} }),
  wishlistLabel: () => 'В избранное',
  WISHLIST_LOCAL_ONLY_HINT: '',
}));

import CategoryPage from '@/components/routes/CategoryPage';
import RouteCard, { type RouteItem } from '@/components/routes/RouteCard';
import { CatalogQuerySchema, queryCatalog } from '@/lib/routes/catalog-query';

function row(id: string, title: string, priceFrom: number | null) {
  return {
    id, title, description: 'Подъём по тропе к кратеру, ночёвка в палатках.', category: 'rybalka',
    lat: 53.1, lng: 158.4, kind: null, url_slug: id,
    // То, что лежит в payload записи: скачанная цена.
    price_from: priceFrom, difficulty: 'medium', duration_days: 3, source_name: null,
  };
}

beforeEach(() => {
  poolQueryMock.mockReset();
  queryMock.mockReset();
  poolQueryMock.mockImplementation((sql: string) => {
    if (sql.includes('LIMIT 24')) {
      return Promise.resolve({ rows: [
        row('baza', 'Рыболовная база', 18000),
        row('reka', 'Сплав по реке Быстрая', 45000),
        row('ozero', 'Озеро Начикинское', null),
      ] });
    }
    if (sql.includes('GROUP BY zone')) return Promise.resolve({ rows: [] });
    if (sql.includes('GROUP BY category')) return Promise.resolve({ rows: [{ category: 'rybalka', count: '3' }] });
    if (sql.includes('COUNT(*) AS count')) return Promise.resolve({ rows: [{ count: '3' }] });
    return Promise.resolve({ rows: [] });
  });
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
});
afterEach(cleanup);

describe('страница категории: цены записи маршрута нет', () => {
  it('у записи цена стоит — на карточке её нет', async () => {
    render(await CategoryPage({ category: 'rybalka' }));
    expect(screen.getByRole('heading', { level: 3, name: 'Рыболовная база' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/₽/);
    expect(document.body.textContent).not.toMatch(/18\s?000|45\s?000/);
  });

  it('запрос страницы цену из записи не выбирает', async () => {
    await CategoryPage({ category: 'rybalka' });
    const listSql = poolQueryMock.mock.calls.map(([sql]) => String(sql)).find((s) => s.includes('LIMIT 24'));
    expect(listSql).toBeDefined();
    expect(listSql).not.toContain('price_from');
  });
});

describe('карточка каталога: старые данные с ценой цены не показывают', () => {
  it('запасная карточка (род не назван) и карточка рода tour — без «от N ₽»', () => {
    // Элемент старой формы: поле цены пришло от вызывающего, которого не обновили.
    const legacy = { id: 'r1', category: 'rybalka', title: 'Рыболовная база', description: 'Река и база.',
      lat: null, lng: null, difficulty: 'medium', durationDays: 3, priceFrom: 18000, minOfferPrice: 18000 } as unknown as RouteItem;
    const { container: a } = render(<RouteCard route={legacy} />);
    expect(a.textContent).toContain('Рыболовная база');
    expect(a.textContent).not.toMatch(/₽/);
    cleanup();
    const { container: b } = render(<RouteCard route={{ ...legacy, kind: 'tour' }} />);
    expect(b.textContent).toContain('Рыболовная база');
    expect(b.textContent).not.toMatch(/₽/);
  });
});

describe('запрос каталога: по цене записи не сортирует и не фильтрует', () => {
  it('старая ссылка с сортировкой по цене — порядок по умолчанию, не 400', () => {
    expect(CatalogQuerySchema.parse({ sort: 'price_asc' }).sort).toBe('title');
    expect(CatalogQuerySchema.parse({ sort: 'price_desc' }).sort).toBe('title');
    expect(CatalogQuerySchema.parse({ sort: 'recommended' }).sort).toBe('recommended');
    expect(CatalogQuerySchema.safeParse({ sort: 'cheapest' }).success).toBe(false);
  });

  it('фильтр цены схема не знает: параметр не доходит до запроса', () => {
    const f = CatalogQuerySchema.parse({ kind: 'route', price_min: '5000', price_max: '25000' }) as Record<string, unknown>;
    expect(f.price_min).toBeUndefined();
    expect(f.price_max).toBeUndefined();
  });

  it.each(['recommended', 'navigable', 'title', 'price_asc'])('SQL каталога (%s) не читает цену записи', async (sort) => {
    await queryCatalog(CatalogQuerySchema.parse({ kind: 'route', sort, price_min: '1' }));
    const sqls = queryMock.mock.calls.map(([sql]) => String(sql));
    expect(sqls.length).toBeGreaterThan(0);
    for (const sql of sqls) expect(sql).not.toContain('price_from');
  });

  it('элемент выдачи цены не несёт, даже если она лежит в payload', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (/COUNT\(\*\)/i.test(sql) && !/SELECT[\s\S]*ark\.title/.test(sql)) return Promise.resolve({ rows: [{ count: '1', total: '1' }] });
      return Promise.resolve({ rows: [{
        id: 'r1', kind: 'route', title: 'Рыболовная база', description: 'Река.', category: 'rybalka',
        payload: { price_from: 18000, difficulty: 'medium' }, price_from: 18000, lat: '53.1', lng: '158.4',
        total_count: '1', count: '1',
      }], rowCount: 1 });
    });
    const res = await queryCatalog(CatalogQuerySchema.parse({ kind: 'route' }));
    expect(res.items.length).toBe(1);
    expect(res.items[0]).not.toHaveProperty('priceFrom');
    expect(JSON.stringify(res.items[0])).not.toMatch(/"priceFrom"/);
  });
});

describe('маршруты оператора: цена — тура, а не записи маршрута', () => {
  it('у тура нет действующей цены — берётся базовая цена тура; цена записи не выбирается', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{
      id: 'r1', title: 'Рыболовная база', category: 'rybalka', description: 'Река.', lat: '53.1', lng: '158.4',
      price_from: '3500', difficulty: 'medium', duration_days: '3',
      effective_price: null, tour_name: 'Рыбалка на Быстрой', tour_price_base: '9000', price_old: null,
      price_unit: 'per_person', tour_duration_hours: null, duration_type: null, multi_day_count: 3,
      tour_image: null, operator_hero_image: null, next_departure_date: null, next_departure_slots: null,
    }] });
    const { GET } = await import('@/app/api/operators/[slug]/routes/route');
    const res = await GET(new Request('https://vedarai.ru/api/operators/x/routes') as never, { params: Promise.resolve({ slug: 'x' }) });
    const body = await res.json() as { routes?: Array<{ priceFrom: number | null }>; data?: Array<{ priceFrom: number | null }> };
    const list = body.routes ?? body.data ?? [];
    expect(list[0]?.priceFrom).toBe(9000);
    const sql = String(poolQueryMock.mock.calls[0]?.[0] ?? '');
    expect(sql).not.toContain('price_from');
  });
});
