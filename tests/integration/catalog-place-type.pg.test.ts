/**
 * Поиск маршрута по виду места пути (`place_type`) — на настоящем PostgreSQL
 * (22.10, карта планировщика).
 *
 * Плитки мест планировщика («Вулканы», «Термальные»…) не давали точек на
 * карте: искали по `activity_type` маршрута, а вид места у маршрута не
 * записан. Теперь /api/routes умеет `place_type` — маршруты, чья точка ПУТИ
 * этого вида. Правило живёт в SQL (EXISTS по route_waypoints с родом связи,
 * живое место, строка маршрута по обоим id) — мок ответил бы на любую форму,
 * поэтому здесь исполняется сам queryCatalog на схеме прода, в своей базе из
 * шаблона (tests/helpers/pg-schema.ts):
 *
 *   — связь `waypoint` и `unknown` находит, `nearby` — нет (CLAUDE.md §4.1);
 *   — скрытое или слитое место пути не делает маршрут «вулканным»;
 *   — маршрут с ark_id (id VIEW = ark_id) находится так же;
 *   — сами места в выдачу не попадают, только маршруты;
 *   — без параметра выдача прежняя: все видимые маршруты, включая «рядом».
 *
 * Вход (Zod, 400 до SQL) и форма параметра — в юните
 * tests/unit/catalog-place-type.test.ts: он идёт в каждом прогоне CI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

if (!PG_URL) {
  console.warn('[catalog-place-type] KERNEL_PG_TEST_URL не задан — тест ПРОПУЩЕН (не прогнан, а не зелёный)');
}

const TEST_DB = 'catalog_place_type_test';

/** [ключ, вид места, видимо, слито] */
const PLACES: Array<[string, string, boolean, boolean]> = [
  ['volc', 'volcano', true, false],
  ['volc-hidden', 'volcano', false, false],
  ['volc-merged', 'volcano', true, true],
  ['lake', 'lake', true, false],
  ['hot', 'hot_spring', true, false],
  ['thermal', 'thermal', true, false],
];

/** [название, место пути, род связи, видим маршрут, с координатами, с ark_id] */
const ROUTES: Array<[string, string, string, boolean, boolean, boolean]> = [
  ['Т Путь через вулкан', 'volc', 'waypoint', true, true, false],
  ['Т Вулкан только рядом', 'volc', 'nearby', true, true, false],
  ['Т Связь не размечена', 'volc', 'unknown', true, true, false],
  ['Т Вулкан скрыт', 'volc-hidden', 'waypoint', true, true, false],
  ['Т Вулкан слит', 'volc-merged', 'waypoint', true, true, false],
  ['Т Озеро', 'lake', 'waypoint', true, true, false],
  ['Т Маршрут с ark_id', 'volc', 'waypoint', true, true, true],
  ['Т Горячий источник', 'hot', 'waypoint', true, true, false],
  ['Т Термальная зона', 'thermal', 'waypoint', true, true, false],
  ['Т Маршрут скрыт', 'volc', 'waypoint', false, true, false],
  ['Т Без координат', 'volc', 'waypoint', true, false, false],
];

withPg('поиск маршрута по виду места пути', () => {
  let pool: Pool;
  let queryCatalog: typeof import('@/lib/routes/catalog-query').queryCatalog;
  let schema: typeof import('@/lib/routes/catalog-query').CatalogQuerySchema;

  beforeAll(async () => {
    const { Pool: PgPool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new PgPool({ connectionString: dbUrl, max: 2 });
    // queryCatalog читает пул приложения — ему нужен тот же адрес.
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    ({ queryCatalog, CatalogQuerySchema: schema } = await import('@/lib/routes/catalog-query'));

    // Миграции сеют свои места и маршруты; сцена должна быть ровно описанной.
    await pool.query('TRUNCATE route_waypoints, kamchatka_routes, places CASCADE');
    const placeId = new Map<string, string>();
    for (const [key, type, visible, merged] of PLACES) {
      // `id` и `ark_id` у прода без умолчаний; `location_type` обязателен
      // (places_shape_check); слитое — ссылкой на какой-то uuid.
      await pool.query(
        `INSERT INTO places (id, ark_id, name, lat, lng, location_type, is_visible, merged_into_id)
         VALUES ($1::text, gen_random_uuid(), $1::text, 53.2, 158.8, $2, $3,
                 CASE WHEN $4::boolean THEN gen_random_uuid() END)`,
        [`place-${key}`, type, visible, merged],
      );
      placeId.set(key, `place-${key}`);
    }
    for (const [title, place, kind, visible, coords, withArk] of ROUTES) {
      // `category` у прода NOT NULL; имя и slug — одним параметром, типы у
      // колонок разные — явное приведение (урок 42P08).
      const r = await pool.query<{ id: string }>(
        `INSERT INTO kamchatka_routes (category, title, slug, is_visible, lat, lng, ark_id)
         VALUES ('hiking', $1::text, $1::text, $2,
                 CASE WHEN $3::boolean THEN 53.25 END, CASE WHEN $3::boolean THEN 158.83 END,
                 CASE WHEN $4::boolean THEN gen_random_uuid() END)
         RETURNING id::text`,
        [title, visible, coords, withArk],
      );
      await pool.query(
        `INSERT INTO route_waypoints (route_id, place_id, position, link_kind) VALUES ($1::uuid, $2, 0, $3)`,
        [r.rows[0].id, placeId.get(place), kind],
      );
    }
    // Место с тем же ark_id, что у маршрута (оба id в VIEW совпали бы): ищется
    // маршрут, и строка-место в выдачу не идёт, даже когда EXISTS сошёлся бы.
    await pool.query(
      `INSERT INTO places (id, ark_id, name, lat, lng, location_type)
       SELECT 'place-twin', ark_id, 'place-twin', 53.2, 158.8, 'volcano'
         FROM kamchatka_routes WHERE title = 'Т Маршрут с ark_id'`,
    );
    // Первый файл прогона строит шаблон схемы — это дольше умолчания в 10 с.
  }, 300_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
  });

  async function titles(params: Record<string, string>): Promise<{ titles: string[]; total: number }> {
    const { items, meta } = await queryCatalog(schema.parse({ limit: '2000', ...params }));
    return { titles: items.map((i) => i.title).sort(), total: meta.total };
  }

  it('вулкан — точка пути (waypoint и unknown), а не «рядом»; скрытое и слитое место не в счёт', async () => {
    const r = await titles({ place_type: 'volcano', hasCoords: 'true' });
    expect(r.titles).toEqual(['Т Маршрут с ark_id', 'Т Путь через вулкан', 'Т Связь не размечена']);
    // Счёт — тем же условием, что и страница.
    expect(r.total).toBe(3);
  });

  it('без координат маршрут на карту не попадает, а без hasCoords — находится', async () => {
    expect((await titles({ place_type: 'volcano' })).titles).toContain('Т Без координат');
    expect((await titles({ place_type: 'volcano', hasCoords: 'true' })).titles).not.toContain('Т Без координат');
  });

  it('несколько видов через запятую — любой из них; сами места в выдачу не идут', async () => {
    const r = await titles({ place_type: 'hot_spring,thermal', hasCoords: 'true' });
    expect(r.titles).toEqual(['Т Горячий источник', 'Т Термальная зона']);
    // Места этих видов в таблице есть — и в выдачу не попали: ищется маршрут.
    const places = await titles({ kind: 'place', location_type: 'hot_spring' });
    expect(places.titles).toEqual(['place-hot']);
    // Место-двойник с ark_id маршрута — не маршрут, в выдаче его нет.
    expect((await titles({ place_type: 'volcano' })).titles).not.toContain('place-twin');
  });

  it('строка маршрута, с которой читаются связи, — живая: скрытый или слитый дубль с ark_id живого не отдаёт ему свой вулкан', async () => {
    // Строка ищется по обоим id (id VIEW = COALESCE(ark_id, id)), и под
    // `kpt.ark_id = ark.id` попадает чужая строка: дубль, чей ark_id совпал
    // с id живого маршрута. Три дубля — скрытый, слитый, скрытый и слитый,
    // — у каждого свой живой маршрут на озеро, и у каждого дубля точка
    // пути — вулкан. Живые маршруты «вулканными» от этого не становятся.
    // Дубли — только в этом тесте: соединение строки маршрута в выборке
    // (krl по обоим id) удвоило бы живой маршрут в прочих проверках.
    const scenes: Array<[string, boolean, boolean]> = [
      ['Т Живой, дубль скрыт', false, false],
      ['Т Живой, дубль слит', true, true],
      ['Т Живой, дубль скрыт и слит', false, true],
    ];
    const created: string[] = [];
    try {
      for (const [live, dupVisible, dupMerged] of scenes) {
        const l = await pool.query<{ id: string }>(
          `INSERT INTO kamchatka_routes (category, title, slug, is_visible, lat, lng)
           VALUES ('hiking', $1::text, $1::text, TRUE, 53.25, 158.83) RETURNING id::text`,
          [live],
        );
        await pool.query(
          `INSERT INTO route_waypoints (route_id, place_id, position, link_kind) VALUES ($1::uuid, 'place-lake', 0, 'waypoint')`,
          [l.rows[0].id],
        );
        const d = await pool.query<{ id: string }>(
          `INSERT INTO kamchatka_routes (category, title, slug, is_visible, merged_into_id, lat, lng, ark_id)
           VALUES ('hiking', $1::text, $1::text, $2::boolean,
                   CASE WHEN $3::boolean THEN $4::text END, 53.25, 158.83, $4::uuid)
           RETURNING id::text`,
          [`${live} — дубль`, dupVisible, dupMerged, l.rows[0].id],
        );
        await pool.query(
          `INSERT INTO route_waypoints (route_id, place_id, position, link_kind) VALUES ($1::uuid, 'place-volc', 0, 'waypoint')`,
          [d.rows[0].id],
        );
        created.push(l.rows[0].id, d.rows[0].id);
      }
      const volcano = await titles({ place_type: 'volcano', hasCoords: 'true' });
      for (const [live] of scenes) expect(volcano.titles, live).not.toContain(live);
      expect(volcano.titles).toEqual(['Т Маршрут с ark_id', 'Т Путь через вулкан', 'Т Связь не размечена']);
      // Свои точки пути живой маршрут отдаёт как прежде: он — маршрут на озеро.
      const lake = await titles({ place_type: 'lake', hasCoords: 'true' });
      for (const [live] of scenes) expect(lake.titles, live).toContain(live);
    } finally {
      if (created.length > 0) {
        await pool.query('DELETE FROM route_waypoints WHERE route_id = ANY($1::uuid[])', [created]);
        await pool.query('DELETE FROM kamchatka_routes WHERE id = ANY($1::uuid[])', [created]);
      }
    }
  });

  it('форма запроса карты планировщика (bgRoutesUrl) выполняется на схеме прода', async () => {
    // Ровно то, что уходит с экрана: kind=route, порядок для поля, brief.
    // Сортировка `navigable` читает строку маршрута — 42702 «ambiguous»
    // уже ронял каталог на одной сортировке при живой другой.
    const { bgRoutesUrl } = await import('@/lib/planner/bg-routes');
    for (const tile of ['volcano', 'trekking']) {
      const sp = Object.fromEntries(new URL(bgRoutesUrl(tile), 'http://x').searchParams);
      const { items, meta } = await queryCatalog(schema.parse(sp));
      expect(items.every((i) => i.kind === 'route'), tile).toBe(true);
      if (tile === 'volcano') {
        expect(items.map((i) => i.title).sort()).toEqual(['Т Маршрут с ark_id', 'Т Путь через вулкан', 'Т Связь не размечена']);
        expect(meta.total).toBe(3);
      }
    }
  });

  it('вид, которого на пути нет, — пусто, а не всё подряд', async () => {
    expect(await titles({ place_type: 'geyser', hasCoords: 'true' })).toEqual({ titles: [], total: 0 });
  });

  it('без параметра — прежняя выдача: все видимые маршруты с координатами, и «рядом» тоже', async () => {
    const r = await titles({ kind: 'route', hasCoords: 'true' });
    const expected = ROUTES.filter(([, , , visible, coords]) => visible && coords).map(([t]) => t).sort();
    expect(r.titles).toEqual(expected);
    expect(r.titles).toContain('Т Вулкан только рядом');
    // Прямой счёт по VIEW — то же число: параметр ничего не добавляет к прежним вызовам.
    const direct = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM agent_route_knowledge
        WHERE is_visible = TRUE AND kind = 'route' AND lat IS NOT NULL AND lng IS NOT NULL`,
    );
    expect(r.total).toBe(direct.rows[0].n);
  });
});
