/**
 * Перепись «каким путём закрытие парка дошло до места» (слово владельца 22.11
 * «1 да», #3487 — Халактырский пляж). Держит:
 *  - правило закрытия собрано из тех же путей, что зовёт перепись: своего
 *    текста путей у переписи нет;
 *  - «только через маршрут» — когда имя места и контур молчат;
 *  - счёт и порядок списка, маршруты-причины, предел списка назван числом;
 *  - разбор маршрута по slug — тем же правилом разрешения, что карточка;
 *  - дверь: секрет, проверка параметров, отказ базы — 500 с SQLSTATE в логе.
 * SQL на настоящей базе — tests/integration/park-scope-census.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: db.query } }));

import { PARK_PATHS, PARK_MEMBERSHIP_SQL, PARK_SCOPED_SQL, type ParkPathKey } from '@/lib/services/safety/alert-place-scope';
import {
  ROUTE_ONLY_LIMIT, PLACE_PARK_PATHS_SQL, ROUTE_PARK_PATHS_SQL, PLACE_PARK_ROUTES_SQL, PLACES_BY_SLUG_SQL,
  ROUTE_TERRITORY_PARKS_SQL, countPlacePaths, describeRoutes, isRouteOnly,
  type PlaceParkRow, type PlaceParkRouteRow, type RouteParkRow,
} from '@/lib/services/safety/park-scope-census';
import { GET } from '@/app/api/cron/park-scope-census/route';

const KEYS = PARK_PATHS.map((p) => p.key);
const flags = (on: ParkPathKey[]) => Object.fromEntries(KEYS.map((k) => [k, on.includes(k)])) as Record<ParkPathKey, boolean>;

function placeRow(id: string, on: ParkPathKey[], over: Partial<PlaceParkRow> = {}): PlaceParkRow {
  return {
    place_id: id, slug: id, title: id, lat: 53, lng: 158, park_slug: 'nalychevo', park_name: 'Природный парк «Налычево»',
    status: 'green', status_reason: null, ...flags(on), ...over,
  };
}

describe('правило закрытия и перепись — одни пути', () => {
  it('у каждого пути своё имя; правило закрытия — их OR', () => {
    expect(new Set(KEYS).size).toBe(KEYS.length);
    expect(KEYS).toEqual([
      'own_name', 'route_park', 'route_through_place', 'place_in_route_title',
      'route_title_in_place', 'contour', 'route_through_contour_place',
    ]);
    expect(PARK_SCOPED_SQL).toContain(PARK_MEMBERSHIP_SQL);
    for (const p of PARK_PATHS) expect(PARK_MEMBERSHIP_SQL).toContain(p.sql);
  });

  it('перепись зовёт те же пути по одному и не держит своей копии', () => {
    for (const p of PARK_PATHS) {
      expect(PLACE_PARK_PATHS_SQL).toContain(`COALESCE((${p.sql}), false) AS ${p.key}`);
      expect(ROUTE_PARK_PATHS_SQL).toContain(`COALESCE((${p.sql}), false) AS ${p.key}`);
    }
    expect(PLACE_PARK_PATHS_SQL).toContain(`WHERE (${PARK_MEMBERSHIP_SQL})`);
    expect(ROUTE_PARK_PATHS_SQL).toContain(`LEFT JOIN parks pk ON (${PARK_MEMBERSHIP_SQL})`);
  });
});

describe('«только через маршрут»', () => {
  it('имя или контур — не только маршрут; без путей — не в списке', () => {
    expect(isRouteOnly(['route_through_place'])).toBe(true);
    expect(isRouteOnly(['place_in_route_title', 'route_title_in_place'])).toBe(true);
    expect(isRouteOnly(['route_through_place', 'contour'])).toBe(false);
    expect(isRouteOnly(['route_through_place', 'own_name'])).toBe(false);
    expect(isRouteOnly(['contour'])).toBe(false);
    expect(isRouteOnly(['route_park'])).toBe(false);
    expect(isRouteOnly([])).toBe(false);
  });

  it('счёт, маршруты-причины, не зелёные — первыми', () => {
    const rows = [
      // Имена по алфавиту ставили бы пляж последним: первым его ставит цвет.
      placeRow('city-a', ['route_through_place'], { title: 'Абрикосовая улица' }),
      placeRow('beach', ['route_through_place'], { title: 'Халактырский пляж', status: 'yellow', status_reason: 'park_season' }),
      placeRow('talovye', ['route_through_place', 'contour']),
      placeRow('park', ['own_name']),
      placeRow('name-only', ['place_in_route_title'], { title: 'Берёзовая роща' }),
    ];
    const routes: PlaceParkRouteRow[] = [
      { place_id: 'beach', park_slug: 'nalychevo', title: 'Озеро Приливное – Халактырский пляж', slug: 'prilivnoe', park_name: 'Природный парк "Налычево"', is_visible: true, link_kind: 'waypoint' },
      { place_id: 'city-a', park_slug: 'nalychevo', title: 'Тропа', slug: null, park_name: 'Налычево', is_visible: false, link_kind: 'unknown' },
    ];
    const c = countPlacePaths(rows, routes);
    expect(c.pairs_total).toBe(5);
    expect(c.places_total).toBe(5);
    expect(c.by_path.route_through_place).toBe(3);
    expect(c.by_path.contour).toBe(1);
    expect(c.by_path.own_name).toBe(1);
    expect(c.route_only_total).toBe(3);
    expect(c.route_only_not_green).toBe(1);
    expect(c.route_only[0]).toMatchObject({
      place: 'Халактырский пляж', status: 'yellow', status_reason: 'park_season', paths: ['route_through_place'],
      routes: [{ title: 'Озеро Приливное – Халактырский пляж', link_kind: 'waypoint', visible: true }],
    });
    expect(c.route_only.map((r) => r.slug)).toEqual(['beach', 'city-a', 'name-only']);
    // У пути по имени маршрутов здесь нет — и это не «разошлись».
    expect(c.route_paths_without_routes).toBe(0);
  });

  it('путь через маршрут без найденного маршрута назван числом', () => {
    const c = countPlacePaths([placeRow('x', ['route_through_place'])], []);
    expect(c.route_paths_without_routes).toBe(1);
  });

  it('предел списка: остаток назван числом, а не срезан молча', () => {
    const rows = Array.from({ length: ROUTE_ONLY_LIMIT + 7 }, (_, i) => placeRow(`p${i}`, ['route_through_place']));
    const c = countPlacePaths(rows, []);
    expect(c.route_only_total).toBe(ROUTE_ONLY_LIMIT + 7);
    expect(c.route_only).toHaveLength(ROUTE_ONLY_LIMIT);
    expect(c.route_only_not_listed).toBe(7);
  });
});

describe('разбор маршрута по slug', () => {
  const base: RouteParkRow = {
    query: 'sopka-mishennaya', route_id: 'r1', title: 'Сопка Мишенная', slug: 'sopka-mishennaya',
    park_name: 'Природный парк «Налычево»', mchs_registration_required: false, park_approval_url: null,
    is_visible: true, lat: 53.05, lng: 158.65, park_slug: 'nalychevo', ...flags(['route_park']),
  };
  const nalychevo = {
    slug: 'nalychevo', display_name: 'Природный парк «Налычево»', permit_url: 'https://www.vulcanikamchatki.ru/', permit_email: null,
    permit_office_address: null, permit_office_hours: null, permit_gosuslugi_url: null, permit_online_url: null,
  };

  it('территория, парки по путям, случай разрешения и блок карточки', () => {
    const [r] = describeRoutes(['sopka-mishennaya'], [base], [{ park_name: 'Природный парк «Налычево»', parks: [nalychevo] }]);
    expect(r).toMatchObject({
      query: 'sopka-mishennaya', found: true, matches: 1, title: 'Сопка Мишенная', park_name: 'Природный парк «Налычево»',
      parks: [{ park: 'nalychevo', paths: ['route_park'] }], territory_parks: ['nalychevo'], card_block_shown: true,
    });
    expect(typeof r?.permit_kind).toBe('string');
    expect(r?.card_wording).not.toBeNull();
  });

  it('не найден — так и сказано; вне парков — пустой список парков', () => {
    const outside = { ...base, park_name: null, park_slug: null, ...flags([]) };
    const res = describeRoutes(['nope', 'sopka-mishennaya'], [outside], []);
    expect(res[0]).toEqual({ query: 'nope', found: false });
    expect(res[1]).toMatchObject({ found: true, parks: [], park_name: null, permit_kind: 'none', card_block_shown: false, card_wording: null });
  });
});

describe('дверь GET /api/cron/park-scope-census', () => {
  const url = (q = '') => `https://vedarai.ru/api/cron/park-scope-census${q}`;
  const req = (q = '', auth = 'Bearer s3cret') => new NextRequest(url(q), { headers: auth ? { authorization: auth } : {} });

  beforeEach(() => {
    process.env.CRON_SECRET = 's3cret';
    db.query.mockReset();
  });

  it('без секрета — 401, база не зовётся', async () => {
    const res = await GET(req('', ''));
    expect(res.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('чужие символы в slug — 400 словами, база не зовётся', async () => {
    const res = await GET(req("?places=a';drop"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/slug через запятую/);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('отказ базы — 500 «не выполнена», SQLSTATE в логе', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.query.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '42P01' }));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'Перепись не выполнена' });
    expect(err.mock.calls.flat().join(' ')).toContain('sqlstate=42P01');
    err.mockRestore();
  });

  it('разбор по slug: место и маршрут спрошены своими запросами', async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql === PLACE_PARK_PATHS_SQL) return { rows: [placeRow('halaktyrskij-plyazh', ['route_through_place'], { status: 'yellow', status_reason: 'park_season' })] };
      if (sql === PLACE_PARK_ROUTES_SQL) return { rows: [] };
      if (sql === PLACES_BY_SLUG_SQL) return { rows: [{ slug: 'halaktyrskij-plyazh' }, { slug: 'gorod' }] };
      if (sql === ROUTE_PARK_PATHS_SQL) return { rows: [] };
      if (sql === ROUTE_TERRITORY_PARKS_SQL) return { rows: [] };
      throw new Error('неожиданный запрос');
    });
    const res = await GET(req('?places=halaktyrskij-plyazh,gorod,net-takogo&routes=sopka-mishennaya'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.places.route_only_total).toBe(1);
    expect(body.lookup.places).toEqual([
      { slug: 'halaktyrskij-plyazh', found: true, parks: [{ park: 'nalychevo', paths: ['route_through_place'], status: 'yellow', status_reason: 'park_season', routes: [] }] },
      // Место есть, а ни в одном парке его правило не считает — не «места нет».
      { slug: 'gorod', found: true, parks: [] },
      { slug: 'net-takogo', found: false, parks: [] },
    ]);
    expect(body.lookup.routes).toEqual([{ query: 'sopka-mishennaya', found: false }]);
  });
});
