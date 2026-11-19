/**
 * Цена маршрута — из его туров (слово владельца 18.11 «1»).
 *
 * 17.11 владелец снял из каталога «от N ₽» записи маршрута: число скачано со
 * статьи-источника, тура за ним нет (§0, §24). Затем вернул цену — «иначе как
 * выбирать» — как цену ТУРОВ маршрута: карточка, фильтр и сортировка берут
 * самую низкую цену тура за человека; у маршрута без тура цены нет.
 *
 * Правило — lib/routes/route-tour-price. Здесь — рендером и вызовом:
 *  - слова цены: «от» только у нескольких туров (правило #3487);
 *  - карточка каталога и страница категории показывают цену туров и не
 *    показывают скачанную;
 *  - запрос каталога берёт цену из туров, сортирует с «без цены — в конце»,
 *    фильтрует тем же выражением и в запросе счёта;
 *  - карточка маршрута и её разметка считают цену тура по base_price, а не по
 *    зачёркнутой price_old;
 *  - страница каталога подписывает цену, когда турист выбрал сортировку или
 *    фильтр по ней.
 *
 * Сам SQL на схеме прода — tests/integration/catalog-place-type.pg.test.ts
 * (блок «цена маршрута — из его туров»).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

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
let currentSearch = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(currentSearch),
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));

import CategoryPage from '@/components/routes/CategoryPage';
import RouteCard, { type RouteItem } from '@/components/routes/RouteCard';
import { CatalogQuerySchema, queryCatalog } from '@/lib/routes/catalog-query';
import {
  offerShownPrice,
  routeTourPriceOf,
  routeTourPriceWords,
  ROUTE_PRICE_NOTE_RU,
} from '@/lib/routes/route-tour-price';
import { sortRouteOffers } from '@/lib/routes/route-offer-sort';

beforeEach(() => {
  poolQueryMock.mockReset();
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
});
afterEach(cleanup);

describe('слова цены маршрута', () => {
  it('несколько туров — «от» и откуда цена; один — без «от» (#3487); цены нет — ничего', () => {
    expect(routeTourPriceWords({ priceFrom: 18000, tours: 3 })).toEqual({
      price: 'от 18 000 ₽ за человека', note: 'самая низкая из 3 туров',
    });
    expect(routeTourPriceWords({ priceFrom: 18000, tours: 1 })).toEqual({
      price: '18 000 ₽ за человека', note: 'цена тура',
    });
    expect(routeTourPriceWords({ priceFrom: 5000, tours: 21 })?.note).toBe('самая низкая из 21 тура');
    expect(routeTourPriceWords({ priceFrom: 5000, tours: 11 })?.note).toBe('самая низкая из 11 туров');
    expect(routeTourPriceWords(null)).toBeNull();
  });

  it('строка запроса → цена: нет, ноль или не число — цены нет, а не 0', () => {
    expect(routeTourPriceOf(null, null)).toBeNull();
    expect(routeTourPriceOf('0', 2)).toBeNull();
    expect(routeTourPriceOf('abc', 2)).toBeNull();
    expect(routeTourPriceOf('9500.00', '2')).toEqual({ priceFrom: 9500, tours: 2 });
  });

  it('цена тура — base_price, как на его карточке; зачёркнутая старая не идёт', () => {
    const withOld = { priceBase: 9500, priceOld: 30000, effectivePrice: 30000 };
    expect(offerShownPrice(withOld)).toBe(9500);
    expect(offerShownPrice({ priceBase: null })).toBeNull();
    // Сортировка «Цена» в блоке туров карточки маршрута — по той же цене.
    const offers = [
      { tourId: 1, priceBase: 18000, nextDeparture: null, nextSlots: null },
      { tourId: 2, priceBase: 9500, priceOld: 30000, effectivePrice: 30000, nextDeparture: null, nextSlots: null },
    ];
    expect(sortRouteOffers(offers, 'price').map((o) => o.tourId)).toEqual([2, 1]);
  });
});

describe('карточка каталога: цена туров, скачанной нет', () => {
  const base = { id: 'r1', category: 'rybalka', title: 'Рыболовная база', description: 'Река и база.',
    lat: null, lng: null, difficulty: 'medium', durationDays: 3 };

  it('маршрут с турами — «от N ₽ за человека» и откуда цена', () => {
    render(<RouteCard route={{ ...base, kind: 'route', tourPrice: { priceFrom: 9500, tours: 2 } } as RouteItem} />);
    expect(screen.getByTestId('route-tour-price').textContent).toBe('от 9 500 ₽ за человека · самая низкая из 2 туров');
  });

  it('маршрут без тура и старые поля цены записи — без «₽»', () => {
    // Элемент старой формы: поле цены пришло от вызывающего, которого не обновили.
    const legacy = { ...base, priceFrom: 18000, minOfferPrice: 18000 } as unknown as RouteItem;
    for (const kind of [undefined, 'route', 'tour'] as const) {
      const { container } = render(<RouteCard route={{ ...legacy, kind }} />);
      expect(container.textContent, String(kind)).toContain('Рыболовная база');
      expect(container.textContent, String(kind)).not.toMatch(/₽/);
      cleanup();
    }
  });

  it('карточка без рода (страница категории) показывает цену туров тем же правилом', () => {
    render(<RouteCard route={{ ...base, tourPrice: { priceFrom: 7000, tours: 1 } } as RouteItem} />);
    expect(screen.getByTestId('route-tour-price').textContent).toBe('7 000 ₽ за человека · цена тура');
  });
});

describe('страница категории', () => {
  function row(id: string, title: string, tourPrice: string | null, tours: number | null) {
    return {
      id, title, description: 'Подъём по тропе к кратеру, ночёвка в палатках.', category: 'rybalka',
      lat: 53.1, lng: 158.4, kind: null, url_slug: id, difficulty: 'medium', duration_days: 3, source_name: null,
      // То, что лежит в payload записи (скачанная цена), страница больше не выбирает.
      price_from: 45000,
      tour_price_from: tourPrice, priced_tours: tours,
    };
  }
  beforeEach(() => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('LIMIT 24')) {
        return Promise.resolve({ rows: [
          row('baza', 'Рыболовная база', null, null),
          row('reka', 'Сплав по реке Быстрая', '9500.00', 2),
          row('ozero', 'Озеро Начикинское', null, null),
        ] });
      }
      if (sql.includes('GROUP BY category')) return Promise.resolve({ rows: [{ category: 'rybalka', count: '3' }] });
      if (sql.includes('COUNT(*) AS count')) return Promise.resolve({ rows: [{ count: '3' }] });
      return Promise.resolve({ rows: [] });
    });
  });

  it('цена — только у маршрута с туром, из туров; скачанной нет', async () => {
    render(await CategoryPage({ category: 'rybalka' }));
    const prices = screen.getAllByTestId('route-tour-price').map((n) => n.textContent);
    expect(prices).toEqual(['от 9 500 ₽ за человека · самая низкая из 2 туров']);
    expect(document.body.textContent).not.toMatch(/45\s?000/);
  });

  it('запрос страницы берёт цену из туров, а не из записи маршрута', async () => {
    await CategoryPage({ category: 'rybalka' });
    const listSql = poolQueryMock.mock.calls.map(([sql]) => String(sql)).find((s) => s.includes('LIMIT 24'))!;
    expect(listSql).toContain('v_route_marketplace');
    expect(listSql).not.toMatch(/payload\s*->>?\s*'price_from'/);
  });
});

describe('запрос каталога', () => {
  const sqls = () => queryMock.mock.calls.map(([sql]) => String(sql));

  it('сортировка и фильтр по цене — значения схемы', () => {
    expect(CatalogQuerySchema.parse({ sort: 'price_asc' }).sort).toBe('price_asc');
    expect(CatalogQuerySchema.parse({ sort: 'price_desc' }).sort).toBe('price_desc');
    const f = CatalogQuerySchema.parse({ kind: 'route', price_min: '5000', price_max: '25000' });
    expect([f.price_min, f.price_max]).toEqual([5000, 25000]);
  });

  it.each(['recommended', 'navigable', 'title', 'price_asc', 'price_desc'])('SQL (%s) не читает цену записи маршрута', async (sort) => {
    await queryCatalog(CatalogQuerySchema.parse({ kind: 'route', sort, price_min: '1' }));
    expect(sqls().length).toBe(2);
    for (const sql of sqls()) expect(sql).not.toMatch(/payload\s*->>?\s*'price_from'/);
  });

  it('по цене: «без цены — в конце» в обе стороны; в recommended цены нет', async () => {
    await queryCatalog(CatalogQuerySchema.parse({ kind: 'route', sort: 'price_asc' }));
    expect(sqls()[0]).toMatch(/ORDER BY\s+tp\.price_from ASC NULLS LAST/);
    queryMock.mockClear();
    await queryCatalog(CatalogQuerySchema.parse({ kind: 'route', sort: 'price_desc' }));
    expect(sqls()[0]).toMatch(/ORDER BY\s+tp\.price_from DESC NULLS LAST/);
    queryMock.mockClear();
    await queryCatalog(CatalogQuerySchema.parse({ kind: 'route', sort: 'recommended' }));
    const order = sqls()[0].split('ORDER BY').pop()!;
    expect(order).not.toMatch(/price/);
  });

  it('фильтр по цене стоит и в запросе счёта — тем же выражением из туров', async () => {
    await queryCatalog(CatalogQuerySchema.parse({ kind: 'route', price_min: '5000', price_max: '25000' }));
    const [data, count] = sqls();
    for (const sql of [data, count]) {
      expect(sql.match(/FROM v_route_marketplace v/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(sql).toContain(`v.price_unit = 'per_person'`);
    }
    const [, countParams] = queryMock.mock.calls[1] as [string, unknown[]];
    expect(countParams).toEqual(['route', 5000, 25000]);
  });

  it('элемент выдачи несёт цену туров, а не цену из payload', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (/COUNT\(\*\)::int AS total/.test(sql)) return Promise.resolve({ rows: [{ total: 2 }] });
      const r = (id: string, tp: string | null, tours: number | null) => ({
        id, kind: 'route', title: id, description: 'Река.', category: 'rybalka',
        payload: { price_from: 18000 }, lat: '53.1', lng: '158.4',
        tour_price_from: tp, priced_tours: tours,
      });
      return Promise.resolve({ rows: [r('с туром', '9500.00', 2), r('без тура', null, 0)], rowCount: 2 });
    });
    const res = await queryCatalog(CatalogQuerySchema.parse({ kind: 'route' }));
    expect(res.items.map((i) => i.tourPrice)).toEqual([{ priceFrom: 9500, tours: 2 }, null]);
    expect(JSON.stringify(res.items)).not.toMatch(/"priceFrom":18000/);
  });
});

describe('маршруты оператора: цена — base_price тура', () => {
  it('зачёркнутая старая цена (price_old, она же effective_price вьюхи) ценой не становится', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{
      id: 'r1', title: 'Рыболовная база', category: 'rybalka', description: 'Река.', lat: '53.1', lng: '158.4',
      price_from: '3500', difficulty: 'medium', duration_days: '3',
      effective_price: '30000', tour_name: 'Рыбалка на Быстрой', tour_price_base: '9000', price_old: '30000',
      price_unit: 'per_person', tour_duration_hours: null, duration_type: null, multi_day_count: 3,
      tour_image: null, operator_hero_image: null, next_departure_date: null, next_departure_slots: null,
    }] });
    const { GET } = await import('@/app/api/operators/[slug]/routes/route');
    const res = await GET(new Request('https://vedarai.ru/api/operators/x/routes') as never, { params: Promise.resolve({ slug: 'x' }) });
    const body = await res.json() as { routes?: Array<{ priceFrom: number | null; priceOld: number | null }>; data?: Array<{ priceFrom: number | null; priceOld: number | null }> };
    const list = body.routes ?? body.data ?? [];
    expect(list[0]?.priceFrom).toBe(9000);
    expect(list[0]?.priceOld).toBe(30000);
    const sql = String(poolQueryMock.mock.calls[0]?.[0] ?? '');
    expect(sql).not.toMatch(/payload\s*->>?\s*'price_from'/);
  });
});

describe('страница каталога: цена подписана, когда турист её выбрал', () => {
  const items: RouteItem[] = [
    { id: 'a', kind: 'route', category: 'rybalka', title: 'Сплав по реке Быстрая', description: 'Река.',
      lat: 53.1, lng: 158.4, difficulty: 'medium', durationDays: 3, tourPrice: { priceFrom: 9500, tours: 2 } },
    { id: 'b', kind: 'route', category: 'rybalka', title: 'Озеро Начикинское', description: 'Озеро.',
      lat: 53.1, lng: 158.4, difficulty: 'easy', durationDays: 1, tourPrice: null },
  ];
  async function show(search: string) {
    currentSearch = search;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true, data: items, meta: { total: 2, page: 1, pages: 1 },
    }), { headers: { 'content-type': 'application/json' } })));
    const { default: RoutesPageClient } = await import('@/app/routes/_RoutesPageClient');
    await act(async () => {
      render(<RoutesPageClient initialItems={items} initialMeta={{ total: 2, pages: 1 }} initialError={false}
        initialKey="" lockedKind="route" />);
    });
  }
  afterEach(() => { vi.unstubAllGlobals(); currentSearch = ''; });

  it('сортировка по цене — подпись правила и цена на карточке', async () => {
    await show('sort=price_asc');
    expect(screen.getByTestId('route-price-note').textContent).toBe(ROUTE_PRICE_NOTE_RU);
    expect(screen.getAllByTestId('route-tour-price').map((n) => n.textContent))
      .toEqual(['от 9 500 ₽ за человека · самая низкая из 2 туров']);
    expect((screen.getByRole('combobox', { name: 'Сортировка маршрутов' }) as HTMLSelectElement).value).toBe('price_asc');
  });

  it('фильтр по цене — та же подпись', async () => {
    await show('price=0-5000');
    expect(screen.getByTestId('route-price-note').textContent).toBe(ROUTE_PRICE_NOTE_RU);
  });

  it('порядок по умолчанию — подписи нет, цена на карточке есть', async () => {
    await show('');
    expect(screen.queryByTestId('route-price-note')).toBeNull();
    expect(screen.getAllByTestId('route-tour-price')).toHaveLength(1);
  });
});
