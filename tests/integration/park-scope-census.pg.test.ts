/**
 * Перепись «каким путём закрытие парка дошло до места» на настоящем
 * PostgreSQL (слово владельца 22.11 «1 да», #3487). Сцена — как у
 * Халактырского пляжа: маршрут с записанной территорией «Налычево» идёт через
 * точку внутри контура парка и через точку вне его. Судится то, что решает
 * база:
 *  - запросы переписи выполняются на схеме прода (вывод типов, JOIN, CTE);
 *  - пляж «в парке» только через маршрут, с этим маршрутом-причиной и цветом
 *    карточки; место в контуре и место с именем парка — нет; место «рядом» и
 *    город — не в парке вовсе;
 *  - разбор маршрута по slug и по номеру: территория, путь, строки справочника.
 *
 * Своя база `park_scope_census_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';
import {
  PLACE_PARK_PATHS_SQL, PLACE_PARK_ROUTES_SQL, PLACES_BY_SLUG_SQL, ROUTE_PARK_PATHS_SQL, ROUTE_TERRITORY_PARKS_SQL,
  countPlacePaths, describeRoutes, type PlaceParkRow, type PlaceParkRouteRow, type RouteParkRow,
} from '@/lib/services/safety/park-scope-census';
import type { ParkPermitRow } from '@/lib/parks/route-permit';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[park-scope-census.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'park_scope_census_test';

const INSIDE = { id: 'psc-inside', slug: 'psc-inside', name: 'Таловские источники (тест)', ark: 'e0000000-0000-4000-8000-000000000001' };
const BEACH = { id: 'psc-beach', slug: 'psc-beach', name: 'Пляж у города (тест)', ark: 'e0000000-0000-4000-8000-000000000002' };
const NAMED = { id: 'psc-named', slug: 'psc-named', name: 'Природный парк Налычево (тест)', ark: 'e0000000-0000-4000-8000-000000000003' };
const NEAR = { id: 'psc-near', slug: 'psc-near', name: 'Музей у тропы (тест)', ark: 'e0000000-0000-4000-8000-000000000004' };
const CITY = { id: 'psc-city', slug: 'psc-city', name: 'Городская набережная (тест)', ark: 'e0000000-0000-4000-8000-000000000005' };
const OURS = [INSIDE, BEACH, NAMED, NEAR, CITY];
const ROUTE_ID = 'f0000000-0000-4000-8000-000000000001';
const CITY_ROUTE_ID = 'f0000000-0000-4000-8000-000000000002';

withPg('перепись охвата закрытий парков (park-scope-census)', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });

    await pool.query(
      `INSERT INTO parks (slug, display_name, search_term)
       VALUES ('nalychevo', 'Природный парк «Налычево»', 'Налычево')
       ON CONFLICT (slug) DO NOTHING`,
    );
    for (const p of OURS) {
      await pool.query(
        `INSERT INTO places (id, name, slug, lat, lng, ark_id, location_type, zone, is_visible)
         VALUES ($1, $2, $3, 53.1, 158.7, $4, 'lake', 'avachinsky', TRUE)`,
        [p.id, p.name, p.slug, p.ark],
      );
    }
    await pool.query(
      `INSERT INTO location_real_time_status (agent_route_id, recommender_status, status_reason)
       VALUES ($1, 'yellow', 'park_season')
       ON CONFLICT DO NOTHING`,
      [BEACH.ark],
    );
    // Территория — свободным текстом, как её записал импорт (миграция 712).
    await pool.query(
      `INSERT INTO kamchatka_routes (id, category, title, slug, park_name, zone, is_visible)
       VALUES ($1, 'trekking', 'Озеро — пляж (тест)', 'psc-route', 'Природный парк "Налычево"', 'avachinsky', TRUE),
              ($2, 'trekking', 'Сопка в городе (тест)', 'psc-city-route', NULL, 'avachinsky', TRUE)`,
      [ROUTE_ID, CITY_ROUTE_ID],
    );
    await pool.query(
      `INSERT INTO route_waypoints (route_id, place_id, position, link_kind) VALUES
         ($1, $2, 0, 'waypoint'),
         ($1, $3, 1, 'waypoint'),
         ($1, $4, 2, 'nearby')`,
      [ROUTE_ID, BEACH.id, INSIDE.id, NEAR.id],
    );
    await pool.query(
      `INSERT INTO place_park_links (place_id, park_slug, reason) VALUES ($1, 'nalychevo', 'тест: точка в контуре')`,
      [INSIDE.id],
    );
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  });

  async function ourPlaceRows(): Promise<PlaceParkRow[]> {
    const { rows } = await pool.query<PlaceParkRow>(PLACE_PARK_PATHS_SQL);
    return rows.filter((r) => OURS.some((p) => p.id === r.place_id));
  }

  it('пляж — только через маршрут, с маршрутом-причиной и цветом карточки', async () => {
    const rows = await ourPlaceRows();
    const ids = rows.map((r) => r.place_id);
    const { rows: routes } = await pool.query<PlaceParkRouteRow>(PLACE_PARK_ROUTES_SQL, [ids]);
    const c = countPlacePaths(rows, routes);

    expect(c.route_only.map((r) => r.slug)).toEqual([BEACH.slug]);
    expect(c.route_only[0]).toMatchObject({
      park: 'nalychevo', paths: ['route_through_place'], status: 'yellow', status_reason: 'park_season',
      routes: [{ title: 'Озеро — пляж (тест)', slug: 'psc-route', link_kind: 'waypoint', visible: true }],
    });
    expect(c.route_only_not_green).toBe(1);
    expect(c.route_paths_without_routes).toBe(0);
  });

  it('контур и имя парка — не «только маршрут»; «рядом» и город — не в парке', async () => {
    const rows = await ourPlaceRows();
    const by = new Map(rows.map((r) => [r.place_id, r]));
    expect(by.get(INSIDE.id)).toMatchObject({ contour: true, route_through_place: true, park_slug: 'nalychevo' });
    expect(by.get(NAMED.id)).toMatchObject({ own_name: true, park_slug: 'nalychevo' });
    expect(by.has(NEAR.id)).toBe(false);
    expect(by.has(CITY.id)).toBe(false);
  });

  it('видимые места по slug: «нет в парке» отличимо от «места нет»', async () => {
    const { rows } = await pool.query<{ slug: string }>(PLACES_BY_SLUG_SQL, [[CITY.slug, 'psc-missing']]);
    expect(rows.map((r) => r.slug)).toEqual([CITY.slug]);
  });

  it('маршрут по slug и по номеру: территория, путь, строки справочника', async () => {
    const queries = ['psc-route', CITY_ROUTE_ID];
    const { rows } = await pool.query<RouteParkRow>(ROUTE_PARK_PATHS_SQL, [queries]);
    const names = [...new Set(rows.map((r) => r.park_name).filter((n): n is string => Boolean(n)))];
    const { rows: terr } = await pool.query<{ park_name: string; parks: ParkPermitRow[] | null }>(ROUTE_TERRITORY_PARKS_SQL, [names]);
    const res = describeRoutes(queries, rows, terr);

    expect(res[0]).toMatchObject({
      query: 'psc-route', found: true, matches: 1, title: 'Озеро — пляж (тест)', park_name: 'Природный парк "Налычево"',
      // Маршрут идёт и через место внутри контура — правило видит оба пути.
      parks: [{ park: 'nalychevo', paths: ['route_park', 'route_through_contour_place'] }], territory_parks: ['nalychevo'],
    });
    expect(res[1]).toMatchObject({
      query: CITY_ROUTE_ID, found: true, title: 'Сопка в городе (тест)', park_name: null, parks: [], permit_kind: 'none',
    });
  });
});
