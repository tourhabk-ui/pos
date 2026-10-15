/**
 * Снятый с витрины тур не попадает в план и рекомендации — находка аудита
 * 15.10 P1-04, пункт 1.10 дорожной карты. На настоящем PostgreSQL.
 *
 * Условие «тур на витрине» стояло руками в каждом читателе, и у каждого —
 * своим набором флагов. План поездки (compose) не смотрел deleted_at, а
 * удаление тура оператором ставит ТОЛЬКО deleted_at (softDeleteTour) — то
 * есть удалённый тур вставал в план с ценой и ссылкой на карточку, которая
 * отвечает 404. Рекомендации, фид для площадок и запасной тур плана не
 * смотрели is_published — а снимают с витрины именно им (миграции
 * 807/808/837). Инструменты Кузьмича раскрывали выключенный тур по id.
 *
 * Мок ответил бы на любой SQL, поэтому сам отбор судится здесь: у одного
 * оператора четыре состояния тура — живой, удалённый, выключенный,
 * неопубликованный — и каждый читатель обязан вернуть только живой.
 *
 * Вторая сцена файла — связь «тур → главное место» (аудит 15.10, TOUR-PLACE,
 * миграция 1286). У туров, заведённых миграциями, route_id пуст, и «Туры
 * сюда» на карточке места и китайские конспекты мест давали на проде ноль.
 * Судится на той же схеме прода: заполнение миграцией только по точному
 * равенству координат с ровно одним живым местом (два кандидата, близкое и
 * скрытое — не связь); карточка места и правило китайских страниц видят тур
 * по главному месту и не видят по «рядом»; правка в кабинете принимает только
 * живое место; планировщик считает спрос в главном месте один раз; перепись
 * называет непривязанные живые туры.
 *
 * Своя база `public_tour_gate_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { createTestDatabase } from '../helpers/pg-schema';

vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));

// Правка тура в кабинете (сцена TOUR-PLACE): вход оператора подставлен, база —
// настоящая. Остальной модуль входа — настоящий, прочие читатели его не зовут.
const { tpOperatorId } = vi.hoisted(() => ({ tpOperatorId: 'b1100000-0000-4000-8000-000000000003' }));
vi.mock('@/lib/auth/middleware', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/middleware')>()),
  requireOperator: vi.fn(async () => ({ userId: 'b1100000-0000-4000-8000-0000000000bb', role: 'operator' })),
}));
vi.mock('@/lib/auth/operator-helpers', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/operator-helpers')>()),
  getOperatorPartnerId: vi.fn(async () => tpOperatorId),
}));
vi.mock('@/lib/seo/indexnow', async (orig) => ({
  ...(await orig<typeof import('@/lib/seo/indexnow')>()),
  pingTourChanged: vi.fn(),
}));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[public-tour-gate.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'public_tour_gate_test';

const OPERATOR = { id: 'b1100000-0000-4000-8000-000000000001', slug: 'test-w2pt-operator', name: 'Тест Витрина' };
type State = 'live' | 'live2' | 'deleted' | 'inactive' | 'unpublished';
const STATES: State[] = ['live', 'live2', 'deleted', 'inactive', 'unpublished'];
/** Вид активности на каждое состояние свой: план берёт по туру каждого вида. */
const activity = (s: State) => `w2pt_${s}`;

withPg('витрина туров: снятый тур не в плане и не в рекомендациях (P1-04)', () => {
  let pool: import('pg').Pool;
  const id = {} as Record<State, string>;
  const live = () => [id.live, id.live2].sort();
  const hidden = () => [id.deleted, id.inactive, id.unpublished];

  beforeAll(async () => {
    const { Pool } = await import('pg');
    // Схема прода — копия шаблона (baseline + миграции новее границы снимка):
    // tests/helpers/pg-schema.ts, аудит 15.10, P2-10.
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });

    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    await pool.query(
      `INSERT INTO partners (id, name, category, contact, slug, is_public, is_verified, status)
       VALUES ($1, $2, 'operator', '{}'::jsonb, $3, TRUE, TRUE, 'active')`,
      [OPERATOR.id, OPERATOR.name, OPERATOR.slug],
    );
    for (const s of STATES) {
      // Удаление — как у softDeleteTour: только deleted_at, флаги остаются true.
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                     min_participants, max_participants, duration_hours, difficulty,
                                     is_active, is_published, deleted_at)
         VALUES ($1, $2, $3, $4, 1000, 'per_person', 1, 10, 8, 'easy',
                 $5, $6, CASE WHEN $7 THEN NOW() ELSE NULL END)
         RETURNING id::text`,
        [OPERATOR.id, `W2PT тур ${s}`, `w2pt-tour-${s}`, activity(s), s !== 'inactive', s !== 'unpublished', s === 'deleted'],
      );
      id[s] = rows[0].id;
    }
    // Запасные туры к живому: все прочие состояния.
    let priority = 0;
    for (const s of STATES.filter((x) => x !== 'live')) {
      await pool.query(
        `INSERT INTO contingency_rules (operator_id, primary_tour_id, alternative_tour_id, priority)
         VALUES ($1, $2, $3, $4)`,
        [OPERATOR.id, id.live, id[s], ++priority],
      );
    }
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
  });

  it('план поездки (composeTrip): удалённого, выключенного и снятого тура в плане нет', async () => {
    const { composeTrip } = await import('@/lib/planner/compose');
    const plan = await composeTrip({
      total_days: 30, budget_total: 10_000_000, interests: STATES.map(activity), month: 7, group_size: 2,
    });
    expect(plan, 'живые туры есть — план не пуст').not.toBeNull();
    const ids = (plan?.tours ?? []).map((t) => String(t.id)).sort();
    expect(ids).toEqual(live());
    for (const h of hidden()) expect(ids).not.toContain(h);
  });

  it('запасной тур плана (fetchContingencyAlternatives) — только с витрины', async () => {
    const { fetchContingencyAlternatives, createPlannerCache } = await import('@/lib/planner');
    const alts = await fetchContingencyAlternatives(id.live, createPlannerCache());
    expect(alts.map((a) => String(a.tourId))).toEqual([id.live2]);
  });

  it('рекомендации (getRecommendations): по виду снятого тура — пусто, по виду живого — он', async () => {
    const { getRecommendations } = await import('@/lib/search/tour-recommend');
    const user = 'b1100000-0000-4000-8000-0000000000aa';
    for (const s of STATES) {
      const recs = await getRecommendations(user, 6, activity(s));
      const expected = s === 'live' || s === 'live2' ? [id[s]] : [];
      expect(recs.map((r) => String(r.id)), s).toEqual(expected);
    }
  });

  it('фид для площадок (/api/tours-feed): только живые туры оператора', async () => {
    const { GET } = await import('@/app/api/tours-feed/route');
    const res = await GET(new NextRequest(`http://localhost/api/tours-feed?operator=${OPERATOR.slug}`));
    expect(res.status).toBe(200);
    const body = await res.json() as { tours: { id: string | number }[] };
    expect(body.tours.map((t) => String(t.id)).sort()).toEqual(live());
  });

  it('инструменты Кузьмича: поиск, подробности, даты и сравнение не видят снятый тур', async () => {
    const { getTouristTools } = await import('@/lib/agents/sdk/tourist-tools');
    const tools = getTouristTools(null);
    const run = async (name: string, args: Record<string, unknown>) => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`инструмента ${name} нет`);
      return JSON.parse(await t.execute(args)) as Record<string, unknown>;
    };

    for (const s of STATES) {
      const found = await run('search_tours', { activity_type: activity(s) });
      expect(found.found, `search_tours ${s}`).toBe(s === 'live' || s === 'live2' ? 1 : 0);
    }
    for (const h of hidden()) {
      expect((await run('get_tour_details', { tour_id: h })).error, `get_tour_details ${h}`).toBe('Тур не найден или снят с публикации');
      const avail = await run('check_availability', { tour_id: h });
      expect(avail.available, `check_availability ${h}`).toBe(false);
      expect(avail.message).toBe('Тур не найден.');
    }
    expect((await run('get_tour_details', { tour_id: id.live })).title).toBe('W2PT тур live');

    const cmp = await run('compare_tours', { tour_ids: [id.live, id.deleted, id.inactive].join(',') });
    expect((cmp.comparison as { id: string | number }[]).map((t) => String(t.id))).toEqual([id.live]);
  });

  it('каталог и его сводка после снятия второго канона: те же два живых тура', async () => {
    const { queryMarketplaceTours, queryCatalogSummary, MarketplaceToursQuerySchema } = await import('@/lib/search/tour-search');
    const r = await queryMarketplaceTours(MarketplaceToursQuerySchema.parse({ limit: 100 }));
    expect(r.tours.filter((t) => t.operator_id === OPERATOR.id).map((t) => String(t.id)).sort()).toEqual(live());
    const s = await queryCatalogSummary();
    const ours = s.byActivity.filter((b) => b.activity_type.startsWith('w2pt_')).map((b) => b.activity_type).sort();
    expect(ours).toEqual([activity('live'), activity('live2')]);
  });

  it('чат виджета партнёра (loadPartnerTours): только живые туры этого оператора, закреплённый первым, соседа нет', async () => {
    // Аудит 15.10, WID-safety: чат на сайте партнёра подбирал туры по всей
    // платформе и советовал туры конкурентов. Сосед с живым туром и
    // закрепление заводятся здесь, последним тестом файла, — прочим читателям
    // сцена остаётся прежней.
    const RIVAL = 'b1100000-0000-4000-8000-000000000002';
    await pool.query(
      `INSERT INTO partners (id, name, category, contact, slug, is_public, is_verified, status)
       VALUES ($1, 'Тест Сосед', 'operator', '{}'::jsonb, 'test-w2pt-rival', TRUE, TRUE, 'active')`,
      [RIVAL],
    );
    await pool.query(
      `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                   min_participants, max_participants, duration_hours, difficulty,
                                   is_active, is_published, pinned_at)
       VALUES ($1, 'W2PT тур соседа', 'w2pt-tour-rival', 'w2pt_rival', 1000, 'per_person', 1, 10, 8, 'easy',
               TRUE, TRUE, NOW())`,
      [RIVAL],
    );
    // Партнёр закрепил второй тур — на своей витрине он вправе ставить его вперёд (§0, 1267).
    await pool.query(`UPDATE operator_tours SET pinned_at = NOW() WHERE id::text = $1`, [id.live2]);

    const { loadPartnerTours } = await import('@/lib/embed/widget-chat');
    const ours = await loadPartnerTours(OPERATOR.id);
    expect(ours?.map((t) => t.id)).toEqual([id.live2, id.live]);
    const theirs = await loadPartnerTours(RIVAL);
    expect(theirs?.map((t) => t.title)).toEqual(['W2PT тур соседа']);
  });
  // ── Сцена TOUR-PLACE: главное место тура (аудит 15.10, миграция 1286) ──────
  describe('главное место тура (TOUR-PLACE)', () => {
    const TP = { id: tpOperatorId, slug: 'test-tp-operator', name: 'Тест Главное Место' };
    /** [id, широта, долгота, видимо] — места сцены. */
    const PLACES: Array<[string, number, number, boolean]> = [
      ['tp-place-exact', 52.4321, 158.1234, true],
      ['tp-place-twin-a', 53.1111, 158.2222, true],
      ['tp-place-twin-b', 53.1111, 158.2222, true],
      ['tp-place-near', 54.0001, 159.0001, true],
      ['tp-place-hidden', 55.5, 160.5, false],
      ['tp-place-vis', 56.1, 161.1, true],
      ['tp-place-vis-hidden-twin', 56.1, 161.1, false],
      ['tp-place-nearby', 57.0, 162.0, true],
      ['tp-place-pick', 58.0, 163.0, true],
      ['tp-place-merged', 58.5, 163.5, true],
    ];
    const tour: Record<string, string> = {};
    let routeBoth = '';
    const migration = readFileSync(join(process.cwd(), 'migrations', '1286_operator_tours_main_place.sql'), 'utf8');
    const linkOf = async (slug: string) => (await pool.query<{ main_place_id: string | null; main_place_source: string | null }>(
      `SELECT main_place_id, main_place_source FROM operator_tours WHERE slug = $1`, [slug],
    )).rows[0];

    beforeAll(async () => {
      await pool.query(
        `INSERT INTO partners (id, name, category, contact, slug, is_public, is_verified, status)
         VALUES ($1, $2, 'operator', '{}'::jsonb, $3, TRUE, TRUE, 'active')`,
        [TP.id, TP.name, TP.slug],
      );
      const arkOf: Record<string, string> = {};
      for (const [pid, lat, lng, visible] of PLACES) {
        const r = await pool.query<{ ark_id: string }>(
          `INSERT INTO places (id, ark_id, name, slug, lat, lng, is_visible, location_type)
           VALUES ($1::text, gen_random_uuid(), $2::text, $1::text, $3, $4, $5, 'volcano')
           RETURNING ark_id::text`,
          [pid, `Место ${pid}`, lat, lng, visible],
        );
        arkOf[pid] = r.rows[0].ark_id;
      }
      await pool.query(`UPDATE places SET merged_into_id = $1::uuid WHERE id = 'tp-place-merged'`, [arkOf['tp-place-pick']]);

      // [slug, широта, долгота, опубликован, заранее заданное главное место]
      const TOURS: Array<[string, number | null, number | null, boolean, string | null]> = [
        ['tp-exact', 52.4321, 158.1234, true, null],          // ровно одно место — связь
        ['tp-twin', 53.1111, 158.2222, true, null],           // два места в точке — не улика
        ['tp-approx', 54.0, 159.0, true, null],               // «приблизительно», как 1176
        ['tp-nocoords', null, null, true, null],              // как Толмачёво в 1217
        ['tp-hidden-coords', 55.5, 160.5, true, null],        // совпало только со скрытым
        ['tp-vis', 56.1, 161.1, true, null],                  // скрытый двойник не мешает
        ['tp-draft', 52.4321, 158.1234, false, null],         // черновик: связь есть, витрины нет
        ['tp-preset', 52.4321, 158.1234, true, 'tp-place-pick'], // выбор оператора не перетирается
        ['tp-nearby', null, null, true, null],                // только «рядом» по маршруту
        ['tp-both', 56.1, 161.1, true, null],                 // маршрут и главное место — одно место
      ];
      for (const [slug, lat, lng, published, preset] of TOURS) {
        const r = await pool.query<{ id: string }>(
          `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                       min_participants, max_participants, duration_hours, difficulty,
                                       is_active, is_published, latitude, longitude,
                                       main_place_id, main_place_source)
           VALUES ($1, $2, $3, 'tp_place', 5000, 'per_person', 1, 10, 8, 'easy',
                   TRUE, $4, $5, $6, $7::text, CASE WHEN $7::text IS NULL THEN NULL ELSE 'operator' END)
           RETURNING id::text`,
          [TP.id, `TP тур ${slug}`, slug, published, lat, lng, preset],
        );
        tour[slug] = r.rows[0].id;
      }
      const routes = await pool.query<{ id: string }>(
        `INSERT INTO kamchatka_routes (category, title) VALUES ('hiking', 'TP маршрут рядом'), ('hiking', 'TP маршрут через место') RETURNING id::text`,
      );
      const [routeNear, rBoth] = routes.rows.map((x) => x.id);
      routeBoth = rBoth;
      await pool.query(`UPDATE operator_tours SET route_id = $1 WHERE slug = 'tp-nearby'`, [routeNear]);
      await pool.query(`UPDATE operator_tours SET route_id = $1 WHERE slug = 'tp-both'`, [routeBoth]);
      await pool.query(
        `INSERT INTO route_waypoints (route_id, place_id, position, link_kind)
         VALUES ($1, 'tp-place-nearby', 0, 'nearby'), ($2, 'tp-place-vis', 0, 'waypoint')`,
        [routeNear, routeBoth],
      );

      // Миграция уже прошла при постройке схемы — на пустой сцене. Здесь она
      // исполняется заново, на данных: тот же файл, что уйдёт на прод.
      await pool.query(migration);
    }, 120_000);

    it('1286: связь — только при точном равенстве с ровно одним живым местом; повтор ничего не меняет', async () => {
      const expected: Record<string, [string | null, string | null]> = {
        'tp-exact': ['tp-place-exact', 'coords_equal'],
        'tp-twin': [null, null],
        'tp-approx': [null, null],
        'tp-nocoords': [null, null],
        'tp-hidden-coords': [null, null],
        'tp-vis': ['tp-place-vis', 'coords_equal'],
        'tp-draft': ['tp-place-exact', 'coords_equal'],
        'tp-preset': ['tp-place-pick', 'operator'],
        'tp-nearby': [null, null],
        'tp-both': ['tp-place-vis', 'coords_equal'],
      };
      const snapshot = async () => Object.fromEntries(await Promise.all(Object.keys(expected).map(async (slug) => {
        const l = await linkOf(slug);
        return [slug, [l.main_place_id, l.main_place_source]] as const;
      })));
      expect(await snapshot()).toEqual(expected);
      await pool.query(migration);
      expect(await snapshot()).toEqual(expected);
      // Источник — только из двух названных.
      await expect(pool.query(`UPDATE operator_tours SET main_place_source = 'guess' WHERE slug = 'tp-exact'`))
        .rejects.toMatchObject({ code: '23514' });
    });

    it('«Туры сюда»: тур по главному месту — «к этому месту»; черновик и «рядом» — нет', async () => {
      const { loadPlaceDetail } = await import('@/lib/places/place-detail');
      const card = async (pid: string) => {
        const r = await loadPlaceDetail(pid, { countView: false });
        expect(r.status, pid).toBe(200);
        return (r.body.data as { tours: Array<{ title: string; linkKind: string }> }).tours;
      };
      const exact = await card('tp-place-exact');
      expect(exact.map((t) => [t.title, t.linkKind])).toEqual([['TP тур tp-exact', 'main_place']]);
      expect(await card('tp-place-nearby')).toEqual([]);
      // Тур связан с местом и маршрутом, и главным местом — одна строка, главное место сильнее.
      const vis = await card('tp-place-vis');
      expect(vis.map((t) => [t.title, t.linkKind]).sort()).toEqual([
        ['TP тур tp-both', 'main_place'], ['TP тур tp-vis', 'main_place'],
      ]);
      expect(await card('tp-place-pick')).toEqual([expect.objectContaining({ title: 'TP тур tp-preset', linkKind: 'main_place' })]);
    });

    it('китайские конспекты: место по главному месту живого тура — да; «рядом» и без связи — нет', async () => {
      const { loadZhPlaceSources } = await import('@/lib/zh/content');
      const ids = (await loadZhPlaceSources()).map((p) => p.id);
      expect(ids).toEqual(expect.arrayContaining(['tp-place-exact', 'tp-place-vis', 'tp-place-pick']));
      for (const no of ['tp-place-nearby', 'tp-place-twin-a', 'tp-place-twin-b', 'tp-place-near', 'tp-place-hidden']) {
        expect(ids, no).not.toContain(no);
      }
      expect(new Set(ids).size, 'место не множится по турам').toBe(ids.length);
    });

    it('кабинет: скрытое, слитое и несуществующее место — 400 без записи; живое — пишется как выбор оператора', async () => {
      const { PATCH } = await import('@/app/api/hub/operator/tours/[id]/route');
      const patch = (slug: string, body: unknown) => PATCH(
        new NextRequest(`http://localhost/api/hub/operator/tours/${tour[slug]}`, {
          method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
        }),
        { params: Promise.resolve({ id: tour[slug] }) },
      );
      for (const bad of ['tp-place-hidden', 'tp-place-merged', 'tp-no-such-place']) {
        const res = await patch('tp-twin', { main_place_id: bad });
        expect(res.status, bad).toBe(400);
        expect(await linkOf('tp-twin')).toEqual({ main_place_id: null, main_place_source: null });
      }
      const okRes = await patch('tp-twin', { main_place_id: 'tp-place-twin-a' });
      expect(okRes.status).toBe(200);
      expect(await linkOf('tp-twin')).toEqual({ main_place_id: 'tp-place-twin-a', main_place_source: 'operator' });

      // Сохранение формы целиком с прежним местом — «по координатам» так и остаётся.
      expect((await patch('tp-exact', { title: 'TP тур tp-exact', main_place_id: 'tp-place-exact' })).status).toBe(200);
      expect(await linkOf('tp-exact')).toEqual({ main_place_id: 'tp-place-exact', main_place_source: 'coords_equal' });

      // Снять — и место, и источник.
      expect((await patch('tp-twin', { main_place_id: null })).status).toBe(200);
      expect(await linkOf('tp-twin')).toEqual({ main_place_id: null, main_place_source: null });
    });

    it('планировщик: места тура — и главное; бронь тура с маршрутом и главным местом в одной точке — один раз', async () => {
      const { fetchTourLoads, fetchCandidateLoads } = await import('@/lib/planner/place-load');
      const day = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, tourist_name)
         VALUES ($1, $3::date, 3, 'Турист Т'), ($2, $3::date, 2, 'Турист В')`,
        [tour['tp-both'], tour['tp-vis'], day],
      );
      const byTour = await fetchTourLoads([tour['tp-exact'], tour['tp-twin'], tour['tp-both']], day, day);
      expect(byTour).not.toBeNull();
      expect(byTour!.get(tour['tp-exact'])?.map((l) => l.placeId)).toEqual(['tp-place-exact']);
      expect(byTour!.get(tour['tp-twin'])).toBeUndefined();
      expect(byTour!.get(tour['tp-both'])).toEqual([expect.objectContaining({ placeId: 'tp-place-vis', planned: 5 })]);

      // Кандидат планировщика называет маршрут его id из выдачи — COALESCE(ark_id, id).
      const cid = (await pool.query<{ cid: string }>(
        `SELECT COALESCE(ark_id, id)::text AS cid FROM kamchatka_routes WHERE id = $1`, [routeBoth],
      )).rows[0].cid;
      const byRoute = await fetchCandidateLoads([cid], day, day);
      expect(byRoute!.get(cid)).toEqual([expect.objectContaining({ placeId: 'tp-place-vis', planned: 5 })]);
    });

    it('перепись: живые туры без маршрута и без главного места — поимённо; источники связи посчитаны', async () => {
      process.env.CRON_SECRET = 'test-secret';
      const { GET } = await import('@/app/api/cron/tour-tracks-census/route');
      const res = await GET(new NextRequest('http://localhost/api/cron/tour-tracks-census', { headers: { authorization: 'Bearer test-secret' } }));
      expect(res.status).toBe(200);
      const body = await res.json() as {
        place_link: {
          live_total: number; with_route: number; with_main_place: number; unlinked: number;
          main_place_by_source: Record<string, number>; main_place_not_shown: number;
          unlinked_items: Array<{ tour_id: string; tour_title: string; operator_name: string | null }>;
        } | null;
        place_link_error?: string;
      };
      expect(body.place_link_error).toBeUndefined();
      const pl = body.place_link!;
      const unlinked = pl.unlinked_items.map((t) => t.tour_title).filter((t) => t.startsWith('TP тур'));
      expect(unlinked.sort()).toEqual(['TP тур tp-approx', 'TP тур tp-hidden-coords', 'TP тур tp-nocoords', 'TP тур tp-twin']);
      expect(pl.unlinked_items.find((t) => t.tour_title === 'TP тур tp-twin')).toEqual({
        tour_id: tour['tp-twin'], tour_title: 'TP тур tp-twin', operator_name: TP.name,
      });
      // Черновик tp-draft в живые не входит.
      expect(pl.unlinked_items.map((t) => t.tour_id)).not.toContain(tour['tp-draft']);
      expect(pl.main_place_by_source.coords_equal).toBeGreaterThanOrEqual(3);
      expect(pl.main_place_by_source.operator).toBeGreaterThanOrEqual(1);
      expect(pl.unlinked).toBe(pl.unlinked_items.length);
    });
  });
});
