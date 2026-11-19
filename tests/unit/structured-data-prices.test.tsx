// @vitest-environment node
/**
 * Цена в разметке Schema.org — только та, что на странице (слово владельца
 * 17.11: «Offer с минимальной ценой и валютой RUB» на карточках туров, мест и
 * маршрутов).
 *
 * - Маршрут: прежде Offer брал цену из записи маршрута — скачанное число без
 *   источника, которого карточка не показывает. Теперь AggregateOffer из туров
 *   блока «Туры по маршруту»: самая низкая и самая высокая цена за человека,
 *   число туров, у каждого — продавец-компания и адрес карточки тура.
 * - Тур: цена называет, за что она — за человека, за группу, за человека в
 *   день. Иначе цена рыбалки за группу читалась бы в выдаче ценой с человека.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { routeAggregateOffer, type RouteOfferInput } from '@/lib/seo/route-offers';
import { buildTourStructuredData, type TourSeoInput } from '@/lib/seo/tour-structured-data';

const SITE = 'https://vedarai.ru';

function offer(p: Partial<RouteOfferInput> & { tourId: number }): RouteOfferInput {
  return {
    tourSlug: null, priceBase: null, priceUnit: 'per_person',
    operator: { name: 'Компания' }, ...p,
  };
}

describe('routeAggregateOffer: цена маршрута — из туров карточки', () => {
  it('самая низкая и самая высокая цена за человека, число туров, валюта RUB', () => {
    const agg = routeAggregateOffer([
      offer({ tourId: 1, priceBase: 18000, operator: { name: 'Край Вулканов' } }),
      offer({ tourId: 2, priceBase: 9500, operator: { name: 'Лагуна Экспедиция' } }),
      offer({ tourId: 3, priceBase: 12000 }),
    ], SITE)!;
    expect(agg['@type']).toBe('AggregateOffer');
    expect(agg.priceCurrency).toBe('RUB');
    expect(agg.lowPrice).toBe(9500);
    expect(agg.highPrice).toBe(18000);
    expect(agg.offerCount).toBe(3);
  });

  it('цена — та, что на карточке тура (base_price); зачёркнутая старая не идёт (18.11)', () => {
    // Вьюха отдаёт effective_price = COALESCE(price_old, base_price), а
    // price_old — зачёркнутая старая цена. До 18.11 она шла в разметку ценой.
    const withOld = { ...offer({ tourId: 1, priceBase: 20000 }), effectivePrice: 25000, priceOld: 25000 } as RouteOfferInput;
    const agg = routeAggregateOffer([withOld], SITE)!;
    expect(agg.lowPrice).toBe(20000);
    expect(agg.highPrice).toBe(20000);
  });

  it('цена за группу и за день в сводку «за человека» не идёт', () => {
    const agg = routeAggregateOffer([
      offer({ tourId: 1, priceBase: 90000, priceUnit: 'per_tour' }),
      offer({ tourId: 2, priceBase: 4000, priceUnit: 'per_day_per_person' }),
      offer({ tourId: 3, priceBase: 11000 }),
    ], SITE)!;
    expect(agg.lowPrice).toBe(11000);
    expect(agg.highPrice).toBe(11000);
    expect(agg.offerCount).toBe(1);
  });

  it('нет ни одной цены за человека — цены в разметке нет, а не «от 0»', () => {
    expect(routeAggregateOffer([], SITE)).toBeNull();
    expect(routeAggregateOffer([
      offer({ tourId: 1, priceBase: 0 }),
      offer({ tourId: 2, priceBase: null }),
      offer({ tourId: 3, priceBase: 50000, priceUnit: 'per_tour' }),
      offer({ tourId: 4, priceBase: 7000, priceUnit: null }),
    ], SITE)).toBeNull();
  });

  it('у каждого тура — свой Offer: единица, адрес карточки тура, продавец-компания', () => {
    const agg = routeAggregateOffer([
      offer({ tourId: 7, tourSlug: 'gorely-za-den', priceBase: 12500, operator: { name: 'Край Вулканов' } }),
      offer({ tourId: 8, priceBase: 14000, operator: { name: null } }),
    ], SITE)!;
    const items = agg.offers as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0].price).toBe(12500);
    expect(items[0].priceCurrency).toBe('RUB');
    expect((items[0].priceSpecification as Record<string, unknown>).unitText).toBe('за человека');
    expect(items[0].url).toBe(`${SITE}/catalog/tours/gorely-za-den`);
    expect(items[0].seller).toEqual({ '@type': 'Organization', name: 'Край Вулканов' });
    // Без slug — адрес по номеру; без имени компании — продавца нет, Ведар им не становится.
    expect(items[1].url).toBe(`${SITE}/catalog/tours/8`);
    expect(items[1].seller).toBeUndefined();
    expect(agg.seller).toBeUndefined();
  });
});

describe('Offer тура называет, за что цена', () => {
  const base: TourSeoInput = {
    id: 7, title: 'Рыбалка на Быстрой', base_price: '60000', operator_name: 'Компания', activity_type: 'fishing',
  };
  const opts = { canonicalUrl: `${SITE}/catalog/tours/7`, siteUrl: SITE, activityLabel: 'Рыбалка', availability: null };
  const offersOf = (t: TourSeoInput) => (buildTourStructuredData(t, [], opts)['@graph'] as Array<Record<string, unknown>>)
    .filter((n) => n['@type'] === 'Product' || n['@type'] === 'TouristTrip')
    .map((n) => n.offers as Record<string, unknown>);

  it.each([
    ['per_tour', 'за группу'],
    ['per_person', 'за человека'],
    ['per_day_per_person', 'за чел./день'],
  ])('%s → «%s» и в Product, и в TouristTrip', (unit, words) => {
    const offers = offersOf({ ...base, price_unit: unit });
    expect(offers).toHaveLength(2);
    for (const o of offers) {
      expect(o.price).toBe(60000);
      expect(o.priceCurrency).toBe('RUB');
      expect(o.priceSpecification).toEqual({
        '@type': 'UnitPriceSpecification', price: 60000, priceCurrency: 'RUB', unitText: words,
      });
    }
  });

  it.each([[null], [undefined], ['per_minute'], ['toString']])('единица %s не записана или чужая — подписи нет', (unit) => {
    for (const o of offersOf({ ...base, price_unit: unit as string | null | undefined })) {
      expect(o.price).toBe(60000);
      expect(o.priceSpecification).toBeUndefined();
    }
  });
});

// ── Страница маршрута: разметка из того, что она отдаёт ─────────────────────

const ROUTE_ID = '3f0b5a2e-1111-4c4c-9d9d-000000001711';
const SLUG = 'vulkan-gorelyj';

const query = vi.fn(async (sql: string) => {
  if (sql.includes('FROM kamchatka_routes WHERE slug = $1')) return { rows: [{ id: ROUTE_ID, kind: 'route', ord: 0 }] };
  if (sql.includes('FROM agent_route_knowledge k')) {
    return { rows: [{
      id: ROUTE_ID, category: 'вулканы', title: 'Вулкан Горелый',
      description: 'Подъём к кратеру по тропе от перевала.',
      lat: '52.55', lng: '158.03', source_url: null,
      // Скачанная цена без источника: на странице её нет — в разметку она не идёт.
      payload: { price_from: 3500, season: 'summer' },
      location_type: null, activity_type: 'hiking', has_real_photo: false,
      kr_zone: null, distance_km: '10', duration_hours: '8', kr_duration_days: null,
      elevation_gain_m: '900', kr_difficulty: null, kr_season: null, mchs_registration_required: false,
    }] };
  }
  return { rows: [] };
});
// Не vi.fn: учёт исходов мока оставляет отвергнутое обещание без обработчика,
// и тест падал бы на «db down», который страница поймала.
let detail: () => Promise<unknown> = async () => ({ kind: 'not_found' });
vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(fn: T) => fn }));
vi.mock('@/lib/database', () => ({ query: (sql: string) => query(sql) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('@/app/routes/[id]/_RouteDetailClient', () => ({ default: () => null }));
vi.mock('@/components/routes/CategoryPage', () => ({ default: () => null }));
vi.mock('@/lib/routes/related', () => ({ relatedRoutesFor: vi.fn(async () => []) }));
vi.mock('@/lib/routes/route-detail', () => ({
  loadRouteDetail: () => detail(),
  logQueryFailure: vi.fn(),
}));

async function tripLd(): Promise<Record<string, unknown>> {
  const { default: Page } = await import('@/app/routes/[id]/page');
  const tree = await Page({ params: Promise.resolve({ id: SLUG }) }) as ReactElement<{ children: ReactElement<{ data: Record<string, unknown> }>[] }>;
  const trip = tree.props.children
    .map((c) => c?.props?.data)
    .find((d) => d && d['@type'] === 'TouristTrip');
  if (!trip) throw new Error('на странице нет TouristTrip');
  return trip;
}

describe('страница маршрута: цена в разметке — из её туров', () => {
  beforeEach(() => { detail = async () => ({ kind: 'not_found' }); });

  it('туры с ценой за человека — AggregateOffer по ним; скачанной цены записи нет', async () => {
    detail = async () => ({ kind: 'found', data: { activityType: 'hiking', offers: [
      offer({ tourId: 1, tourSlug: 'gorely', priceBase: 12500, operator: { name: 'Край Вулканов' } }),
      offer({ tourId: 2, priceBase: 9800, operator: { name: 'Лагуна Экспедиция' } }),
    ] } });
    const ld = await tripLd();
    const agg = ld.offers as Record<string, unknown>;
    expect(agg['@type']).toBe('AggregateOffer');
    expect(agg.lowPrice).toBe(9800);
    expect(agg.highPrice).toBe(12500);
    expect(agg.offerCount).toBe(2);
    expect(JSON.stringify(ld)).not.toContain('3500');
  });

  it('туров нет — цены в разметке нет', async () => {
    detail = async () => ({ kind: 'found', data: { activityType: 'hiking', offers: [] } });
    const ld = await tripLd();
    expect(ld.offers).toBeUndefined();
    expect(ld.name).toBe('Вулкан Горелый');
  });

  it('туры не прочитались — цены нет, а страница с разметкой маршрута есть', async () => {
    detail = async () => { throw Object.assign(new Error('db down'), { code: '57P01' }); };
    const ld = await tripLd();
    expect(ld.offers).toBeUndefined();
    expect(ld.name).toBe('Вулкан Горелый');
  });
});
