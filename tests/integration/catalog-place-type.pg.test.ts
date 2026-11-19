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

  /**
   * Цена маршрута — из его туров (слово владельца 18.11 «1»,
   * lib/routes/route-tour-price). Здесь — сам SQL на схеме прода: вьюха
   * v_route_marketplace (живые туры компаний на витрине), обе привязки тура к
   * маршруту, цена base_price, а не зачёркнутая price_old, только «за
   * человека». Маршруты сцены без координат: прочие проверки файла считают
   * маршруты с координатами, и сцена их не задевает.
   *
   * Вьюха в базе прода соединяет тур с `_agent_route_knowledge_legacy` (её
   * определение в baseline): тур виден, только когда его agent_route_id есть
   * в этой таблице. Сцена кладёт туда номера, к которым привязаны туры.
   */
  describe('цена маршрута — из его туров (18.11)', () => {
    const created = { routes: [] as string[], legacy: [] as string[], tours: [] as string[], partners: [] as string[], places: [] as string[] };
    const id: Record<string, string> = {};

    beforeAll(async () => {
      const partner = async (name: string, isPublic: boolean) => {
        const r = await pool.query<{ id: string }>(
          `INSERT INTO partners (name, slug, category, contact, contacts, is_public, status)
           VALUES ($1::text, $1::text, 'operator', '{}'::jsonb, '{}'::jsonb, $2, 'active') RETURNING id::text`,
          [name, isPublic],
        );
        created.partners.push(r.rows[0].id);
        return r.rows[0].id;
      };
      const pub = await partner('ц-компания-на-витрине', true);
      const hid = await partner('ц-компания-скрыта', false);

      const route = async (title: string, withArk: boolean) => {
        const r = await pool.query<{ id: string; ark_id: string | null }>(
          `INSERT INTO kamchatka_routes (category, title, slug, is_visible, ark_id)
           VALUES ('hiking', $1::text, $1::text, TRUE, CASE WHEN $2::boolean THEN gen_random_uuid() END)
           RETURNING id::text, ark_id::text`,
          [title, withArk],
        );
        created.routes.push(r.rows[0].id);
        return r.rows[0];
      };
      const legacy = async (uuid: string) => {
        await pool.query(
          `INSERT INTO _agent_route_knowledge_legacy (id, route_dedupe_key, category, title, search_text, source_hash, kind)
           VALUES ($1::uuid, $1::text, 'hiking', 'legacy', '', 'h', 'route')`,
          [uuid],
        );
        created.legacy.push(uuid);
      };
      const tour = async (operator: string, linkedTo: string, price: number, unit: string, opts: { old?: number; active?: boolean } = {}) => {
        const r = await pool.query<{ id: string }>(
          `INSERT INTO operator_tours (operator_id, title, base_price, price_old, price_unit, max_participants,
                                       is_active, is_published, activity_type, duration_hours, agent_route_id)
           VALUES ($1, 'ц-тур', $2, $3, $4, 10, $5, TRUE, 'hiking', 6, $6::uuid) RETURNING id::text`,
          [operator, price, opts.old ?? null, unit, opts.active ?? true, linkedTo],
        );
        created.tours.push(r.rows[0].id);
        return r.rows[0].id;
      };

      // Два тура за человека; у дешёвого есть зачёркнутая старая цена 30 000,
      // ещё один — за группу 5 000: он в «от» не идёт.
      const two = await route('Ц Два тура', false);
      await legacy(two.id);
      await tour(pub, two.id, 18000, 'per_person');
      id.cheapWithOld = await tour(pub, two.id, 9500, 'per_person', { old: 30000 });
      await tour(pub, two.id, 5000, 'per_group');
      id.two = two.id;

      // Номер карточки (ark_id) с номером строки разошёлся, тур привязан к
      // номеру карточки: до 18.11 карточка искала только по номеру строки.
      const ark = await route('Ц Номера разошлись', true);
      await legacy(ark.ark_id!);
      id.arkTour = await tour(pub, ark.ark_id!, 12000, 'per_person');
      id.ark = ark.ark_id!;

      // Номера разошлись, а тур привязан к номеру строки — вторая привязка.
      const row = await route('Ц Тур по номеру строки', true);
      await legacy(row.id);
      await tour(pub, row.id, 7000, 'per_person');

      const none = await route('Ц Без тура', false);
      await legacy(none.id);
      const hidden = await route('Ц Тур скрытой компании', false);
      await legacy(hidden.id);
      await tour(hid, hidden.id, 3000, 'per_person');
      const group = await route('Ц Только за группу', false);
      await legacy(group.id);
      await tour(pub, group.id, 4000, 'per_group');
      const off = await route('Ц Тур снят', false);
      await legacy(off.id);
      await tour(pub, off.id, 2000, 'per_person', { active: false });

      // Тур, привязанный к МЕСТУ (номер места есть в старой таблице знаний):
      // у места цены нет (§9) — ни на карточке, ни в фильтре.
      const place = await pool.query<{ ark_id: string }>(
        `INSERT INTO places (id, ark_id, name, lat, lng, location_type)
         VALUES ('place-ц-с-туром', gen_random_uuid(), 'Ц Место с туром', 53.2, 158.8, 'volcano') RETURNING ark_id::text`,
      );
      created.places.push('place-ц-с-туром');
      await legacy(place.rows[0].ark_id);
      await tour(pub, place.rows[0].ark_id, 1000, 'per_person');
    });

    afterAll(async () => {
      await pool.query('DELETE FROM operator_tours WHERE id = ANY($1::bigint[])', [created.tours]);
      await pool.query('DELETE FROM partners WHERE id = ANY($1::uuid[])', [created.partners]);
      await pool.query('DELETE FROM kamchatka_routes WHERE id = ANY($1::uuid[])', [created.routes]);
      await pool.query('DELETE FROM places WHERE id = ANY($1::text[])', [created.places]);
      await pool.query('DELETE FROM _agent_route_knowledge_legacy WHERE id = ANY($1::uuid[])', [created.legacy]);
    });

    async function scene(params: Record<string, string> = {}) {
      const { items, meta } = await queryCatalog(schema.parse({ kind: 'route', limit: '2000', ...params }));
      const own = items.filter((i) => i.title.startsWith('Ц '));
      return { own, total: meta.total, all: items };
    }

    it('цена — самая низкая цена тура за человека, по обеим привязкам; иначе цены нет', async () => {
      const { own } = await scene();
      const price = Object.fromEntries(own.map((i) => [i.title, i.tourPrice]));
      expect(price['Ц Два тура']).toEqual({ priceFrom: 9500, tours: 2 });
      expect(price['Ц Номера разошлись']).toEqual({ priceFrom: 12000, tours: 1 });
      expect(price['Ц Тур по номеру строки']).toEqual({ priceFrom: 7000, tours: 1 });
      for (const t of ['Ц Без тура', 'Ц Тур скрытой компании', 'Ц Только за группу', 'Ц Тур снят']) {
        expect(price[t], t).toBeNull();
      }
    });

    it('сортировка по цене: дешевле выше, без цены — в конце при любом направлении', async () => {
      const asc = (await scene({ sort: 'price_asc' })).own.map((i) => i.title);
      expect(asc.slice(0, 3)).toEqual(['Ц Тур по номеру строки', 'Ц Два тура', 'Ц Номера разошлись']);
      const desc = (await scene({ sort: 'price_desc' })).own.map((i) => i.title);
      expect(desc.slice(0, 3)).toEqual(['Ц Номера разошлись', 'Ц Два тура', 'Ц Тур по номеру строки']);
      // Во всей выдаче маршрут без цены не стоит выше маршрута с ценой.
      for (const sort of ['price_asc', 'price_desc']) {
        const all = (await scene({ sort })).all;
        const firstUnpriced = all.findIndex((i) => i.tourPrice === null);
        const lastPriced = all.map((i) => i.tourPrice !== null).lastIndexOf(true);
        expect(lastPriced, sort).toBeLessThan(firstUnpriced === -1 ? Infinity : firstUnpriced);
      }
    });

    it('фильтр по цене: по самой низкой цене тура; без цены не проходит; счёт тем же условием', async () => {
      const cheap = await scene({ price_max: '10000' });
      expect(cheap.own.map((i) => i.title).sort()).toEqual(['Ц Два тура', 'Ц Тур по номеру строки']);
      expect(cheap.total).toBe(2);
      const dear = await scene({ price_min: '10000' });
      expect(dear.own.map((i) => i.title)).toEqual(['Ц Номера разошлись']);
      expect(dear.total).toBe(1);
      // Место цены не имеет, даже когда к нему привязан тур: фильтр по цене
      // мест не находит, в выдаче мест цены нет.
      const { meta } = await queryCatalog(schema.parse({ kind: 'place', price_max: '1000000' }));
      expect(meta.total).toBe(0);
      const places = await queryCatalog(schema.parse({ kind: 'place', limit: '2000' }));
      const withTour = places.items.find((i) => i.title === 'Ц Место с туром');
      expect(withTour?.tourPrice).toBeNull();
    });

    it('страница категории — то же соединение по таблице без псевдонима', async () => {
      const { routeTourPriceLateralSql } = await import('@/lib/routes/route-tour-price');
      const r = await pool.query<{ title: string; price_from: string | null; tours: number | null }>(
        `SELECT title, tp.price_from, tp.tours FROM agent_route_knowledge
         ${routeTourPriceLateralSql('agent_route_knowledge', 'tp')}
         WHERE category = 'hiking' AND is_visible = TRUE AND title LIKE 'Ц %'`,
      );
      const by = Object.fromEntries(r.rows.map((x) => [x.title, x.price_from == null ? null : Number(x.price_from)]));
      expect(by['Ц Два тура']).toBe(9500);
      expect(by['Ц Номера разошлись']).toBe(12000);
      expect(by['Ц Без тура']).toBeNull();
    });

    it('карточка маршрута: туры по номеру карточки находятся, цена тура — base_price, не зачёркнутая', async () => {
      const { loadRouteDetail } = await import('@/lib/routes/route-detail');
      type Detail = { offers?: Array<{ tourId: number; priceBase: number | null }> };
      const read = async (arkId: string): Promise<Detail> => {
        const r = (await loadRouteDetail(arkId, { explain: false, countView: false })) as unknown as { data?: Detail } & Detail;
        return r.data ?? r;
      };
      const ark = await read(id.ark);
      expect(ark.offers?.map((o) => o.tourId)).toEqual([Number(id.arkTour)]);
      const two = await read(id.two);
      expect(two.offers?.length).toBe(3);
      const cheap = two.offers!.find((o) => o.tourId === Number(id.cheapWithOld))!;
      expect(cheap.priceBase).toBe(9500);
      expect(cheap).not.toHaveProperty('effectivePrice');
    });
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

/**
 * Миграция 1460 (#3473, решения владельца 16.11) на настоящем PostgreSQL:
 * у «Кальдеры вулкана Узон» уходят ровно две связи скрейпа 656, своя точка
 * маршрута и чужие связи остаются; у Костакана суть получает 752,2 м вместо
 * 752 м с записью журнала происхождения, а суть, переписанная человеком,
 * не трогается. Повторный прогон ничего не меняет.
 */
withPg('миграция 1460: Костакан и связи «Кальдеры вулкана Узон»', () => {
  let pool: Pool;
  const ROUTE = 'bea2638c-1537-4281-ab7c-daa3617d8457';
  const SEMYACHIK = '775aa3de-d278-4398-ac95-40e9ed616957';
  const SPRINGS = '56ffac2b-3ad5-46a2-904e-5c29f3229b12';
  const UZON = '5694d055-0000-4000-8000-000000000001';
  const KOSTAKAN = '1d427c44-9f54-47da-99ff-12231705746b';
  const run1460 = async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    await pool.query(readFileSync(join(process.cwd(), 'migrations', '1460_place_cards_3473.sql'), 'utf-8'));
  };

  beforeAll(async () => {
    const { Pool: PgPool } = await import('pg');
    pool = new PgPool({ connectionString: await createTestDatabase(PG_URL, 'migration_1460_test'), max: 2 });
    await pool.query('TRUNCATE route_waypoints, kamchatka_routes, places, description_provenance CASCADE');
    for (const [id, name] of [[SEMYACHIK, 'Вулкан Большой Семячик'], [SPRINGS, 'Нижне-Семячикские термальные источники'], [UZON, 'Узон']]) {
      await pool.query(
        `INSERT INTO places (id, ark_id, name, lat, lng, location_type) VALUES ($1::text, gen_random_uuid(), $2::text, 54.5, 160.0, 'volcano')`,
        [id, name],
      );
    }
    await pool.query(
      `INSERT INTO places (id, ark_id, name, lat, lng, location_type, essence)
       VALUES ($1::text, gen_random_uuid(), 'Озеро Костакан', 53.8, 158.0, 'lake',
               'Озеро у южного подножия вулкана Бакенинг, в верховьях Средней Авачи, на высоте 752 метра; памятник природы регионального значения.')`,
      [KOSTAKAN],
    );
    await pool.query(
      `INSERT INTO kamchatka_routes (id, category, title, slug, is_visible) VALUES ($1::uuid, 'hiking', 'Кальдера вулкана Узон', 'kaldera-uzon', TRUE)`,
      [ROUTE],
    );
    // Другой маршрут с той же точкой — его связь не трогается.
    const other = await pool.query<{ id: string }>(
      `INSERT INTO kamchatka_routes (category, title, slug, is_visible) VALUES ('hiking', 'Вулкан Большой Семячик', 'semyachik', TRUE) RETURNING id::text`,
    );
    for (const [route, place, pos] of [[ROUTE, UZON, 0], [ROUTE, SPRINGS, 7], [ROUTE, SEMYACHIK, 8], [other.rows[0].id, SEMYACHIK, 0]] as const) {
      await pool.query(
        `INSERT INTO route_waypoints (route_id, place_id, position, link_kind) VALUES ($1::uuid, $2, $3, 'waypoint')`,
        [route, place, pos],
      );
    }
    await run1460();
  });

  afterAll(async () => { await pool?.end(); });

  it('у маршрута остаётся своя точка «Узон»; связь Семячика с его собственным маршрутом цела', async () => {
    const { rows } = await pool.query<{ route_id: string; place_id: string }>(
      'SELECT route_id::text, place_id FROM route_waypoints ORDER BY route_id, position',
    );
    const ofUzon = rows.filter((r) => r.route_id === ROUTE).map((r) => r.place_id);
    expect(ofUzon).toEqual([UZON]);
    expect(rows.filter((r) => r.place_id === SEMYACHIK && r.route_id !== ROUTE)).toHaveLength(1);
  });

  it('Костакан: 752,2 м в сути и запись журнала; повтор ничего не меняет', async () => {
    const read = async () => (await pool.query<{ essence: string }>('SELECT essence FROM places WHERE id = $1', [KOSTAKAN])).rows[0].essence;
    expect(await read()).toContain('на высоте 752,2 метра');
    expect(await read()).not.toMatch(/752 метра/);
    const prov = await pool.query<{ written_by: string }>(
      `SELECT written_by FROM description_provenance WHERE entity_kind = 'place' AND entity_title = 'Озеро Костакан'`,
    );
    expect(prov.rows.map((r) => r.written_by)).toEqual(['owner-decision']);
    await run1460();
    expect(await read()).toContain('на высоте 752,2 метра');
    expect((await pool.query('SELECT 1 FROM description_provenance')).rowCount).toBe(1);
  });

  it('суть, переписанная человеком, не трогается', async () => {
    await pool.query(`UPDATE places SET essence = 'Озеро у вулкана Бакенинг.' WHERE id = $1`, [KOSTAKAN]);
    await run1460();
    expect((await pool.query<{ essence: string }>('SELECT essence FROM places WHERE id = $1', [KOSTAKAN])).rows[0].essence)
      .toBe('Озеро у вулкана Бакенинг.');
  });
});


/**
 * Зона планера на настоящем PostgreSQL (#3394 п.3, слово владельца 19.11
 * «отдельная зона»): Курильское озеро в базе — `western` по району, а день
 * планера у него — южная зона. Предикат исполняется на строках с широтой и
 * записанной зоной, без таблиц: судится сам CASE, как его разберёт сервер.
 */
withPg('зона планера: южная по широте, записанная — иначе', () => {
  let pool: Pool;
  beforeAll(async () => {
    const { Pool: PgPool } = await import('pg');
    pool = new PgPool({ connectionString: PG_URL, max: 1 });
  });
  afterAll(async () => { await pool?.end(); });

  it('Курильское озеро — южной, не западной; Ходутка и город — своей; тур без зоны — только Авачинской', async () => {
    const { zoneMatchSql, plannerZoneSql } = await import('@/lib/planner/zone-match');
    const rows = `(VALUES ('kurile', 51.455::float8, 'western'::text), ('khodutka', 52.06, 'avachinsky'),
                          ('esso', 55.93, 'western'), ('city', 53.01, NULL), ('nolat', NULL, 'western')) AS ark(id, lat, zone)`;
    const zoneOf = async () => (await pool.query<{ id: string; z: string | null }>(
      `SELECT id, ${plannerZoneSql('ark')} AS z FROM ${rows} ORDER BY id`,
    )).rows;
    expect(await zoneOf()).toEqual([
      { id: 'city', z: null }, { id: 'esso', z: 'western' }, { id: 'khodutka', z: 'avachinsky' },
      { id: 'kurile', z: 'southern' }, { id: 'nolat', z: 'western' },
    ]);
    const match = async (zone: string) => (await pool.query<{ id: string }>(
      `SELECT id FROM ${rows} WHERE ${zoneMatchSql('ark', '$1')} ORDER BY id`, [zone],
    )).rows.map((r) => r.id);
    expect(await match('southern')).toEqual(['kurile']);
    expect(await match('western')).toEqual(['esso', 'nolat']);
    expect(await match('avachinsky')).toEqual(['city', 'khodutka']);
  });
});
