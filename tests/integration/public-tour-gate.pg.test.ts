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
 * Третья — кабинет оператора (#2642): черновик выглядел там «Активен». Список
 * туров и экран «Чего не хватает» несут ответ того же шлюза (`on_storefront`),
 * и на каждом туре он равен наличию тура в выдаче каталога; «готов к Авито и
 * Яндексу» равен наличию тура в ленте — черновик со всеми полями не готов.
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
      // Отзывов у всех состояний больше, чем у любого тура из миграций: «тренды»
      // берут первые 50 по отзывам, и без этого туры миграций (1338, 1339 —
      // уже за 50 на витрине) вытесняли бы наши из выборки. Решать, кто в
      // выборке, должен шлюз витрины, а не число туров в базе.
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                     min_participants, max_participants, duration_hours, difficulty,
                                     is_active, is_published, deleted_at, review_count)
         VALUES ($1, $2, $3, $4, 1000, 'per_person', 1, 10, 8, 'easy',
                 $5, $6, CASE WHEN $7 THEN NOW() ELSE NULL END, 1000000)
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
    // Первый импорт мозга Кузьмича — секунды работы процессора; под нагрузкой
    // он один съедал предел теста по умолчанию (5 с, CI на main красный по
    // таймауту, ревью 29.10). Здесь, под пределом beforeAll, — один раз.
    await import('@/lib/kuzmich/core');
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

  it('каталог Кузьмича и MCP (loadTourCatalog): все туры витрины по правилу 1в, а не первые 40 по цене (29.10)', async () => {
    // До 29.10 запрос резал каталог «LIMIT 40» по цене: MCP get_tours
    // называл «туров всего 40» при 42 на витрине, самых дорогих не было.
    // Чтобы предел точно был превышен, доливаются 41 дорогой тур другого
    // оператора (свой — не трогать: прочие тесты файла считают свои туры).
    const other = '00000000-0000-4000-8000-0000000c4740';
    await pool.query(
      `INSERT INTO partners (id, name, category, contact, slug, is_public, is_verified, status)
       VALUES ($1, 'Каталог без предела', 'operator', '{}'::jsonb, 'w2pt-catalog-all', TRUE, TRUE, 'active')`, [other],
    );
    // Одним запросом: 41 вставка по одной не укладывалась в 5 с на раннере.
    await pool.query(
      `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                   min_participants, max_participants, duration_hours, is_active, is_published)
       SELECT $1, 'W2PT дорогой ' || i, 'w2pt-expensive-' || i, 'helicopter', 900000 + i, 'per_person', 1, 6, 8, TRUE, TRUE
         FROM generate_series(0, 40) AS i`,
      [other],
    );
    const { publicTourSql } = await import('@/lib/tours/public-visibility');
    const { nearestFreeDateSql } = await import('@/lib/tours/nearest-free-date');
    // Один дорогой тур ведёт календарь со свободной датой: по цене он был бы
    // последним, по правилу 1в (29.10) — первым.
    const pricey = (await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM operator_tours WHERE slug = 'w2pt-expensive-40'`,
    )).rows[0].id;
    await pool.query(
      `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled)
       VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kamchatka')::date + 3, 6, FALSE)`,
      [pricey],
    );
    const storefront = (await pool.query<{ id: string; d: string | null }>(
      `SELECT ot.id::text AS id, ${nearestFreeDateSql('ot')} AS d FROM operator_tours ot WHERE ${publicTourSql('ot')}`,
    )).rows;
    const expected = storefront.map((r) => r.id).sort();
    expect(expected.length).toBeGreaterThan(40);

    // Кэш каталога живёт 3 минуты — часы вперёд, чтобы прочитать базу заново.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    // Живой контекст подсказки (погода, лента МЧС, новости) ходит в чужие
    // сайты с таймаутом 8 с на ленту: сторож базы не должен зависеть от
    // aif.ru и kamgov.ru. Сеть закрыта — живой контекст честно пуст.
    const net = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('сеть закрыта в pg-стороже'));
    const quiet = [vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
    try {
      const { loadTourCatalog, buildTourContext } = await import('@/lib/kuzmich/core');
      const { orderOffersBy, offerOrderDay, OFFER_ORDER_NOTE_AGENT } = await import('@/lib/tours/offer-order');
      const catalog = await loadTourCatalog();
      const inOrder = [...(catalog ?? '').matchAll(/^ID(\d+):/gm)].map((m) => m[1]);
      const ids = [...inOrder].sort();
      expect(ids).toEqual(expected);
      // Порядок — правило 1в: тур с датой первым, остальные — жребий дня; не цена.
      // (Туры миграций со своими календарями тоже стоят впереди — по своим датам.)
      const undated = new Set(storefront.filter((r) => r.d == null).map((r) => r.id));
      expect(undated.has(pricey)).toBe(false);
      expect(inOrder.indexOf(pricey)).toBeLessThan(Math.min(...inOrder.filter((x) => undated.has(x)).map((x) => inOrder.indexOf(x))));
      expect(inOrder).toEqual(orderOffersBy(storefront, (r) => ({ id: r.id, nearestFreeDate: r.d }), { day: offerOrderDay() }).map((r) => r.id));
      expect(catalog).toContain(OFFER_ORDER_NOTE_AGENT);
      // Черновик/удалённый/выключенный не попали.
      expect(catalog).toContain('"W2PT дорогой 40"');
      for (const h of hidden()) expect(ids).not.toContain(h);

      const { paginateTourText, TOURS_PAGE_SIZE } = await import('@/lib/kuzmich/tour-filter');
      const pages = Math.ceil(expected.length / TOURS_PAGE_SIZE);
      expect(paginateTourText(catalog ?? '', pages)).toContain(`туров всего ${expected.length}. Это последняя.`);

      // Подсказка Кузьмича: 40 туров и названо, сколько всего.
      const ctx = await buildTourContext();
      expect(ctx.match(/^ID\d+:/gm)).toHaveLength(40);
      expect(ctx).toContain(`(Здесь 40 туров из ${expected.length} — первые по порядку витрины (правило в шапке).`);
      expect(ctx).not.toContain('первые по цене');
    } finally {
      vi.useRealTimers();
      net.mockRestore();
      for (const q of quiet) q.mockRestore();
      // Дата — только для этого сценария: дальше файл судит «ближайший выезд» витрины.
      await pool.query(`DELETE FROM tour_availability WHERE operator_tour_id = $1::bigint`, [pricey]);
    }
  }, 30_000);

  it('каталог сайта (queryMarketplaceTours): порядок — правило 1в на тех же строках, цена — ничья правилом, ?sort=recent — как по умолчанию (29.10)', async () => {
    const { queryMarketplaceTours, MarketplaceToursQuerySchema } = await import('@/lib/search/tour-search');
    const { publicTourSql } = await import('@/lib/tours/public-visibility');
    const { nearestFreeDateSql } = await import('@/lib/tours/nearest-free-date');
    const { orderOffersBy, compareTourOffers, offerOrderDay } = await import('@/lib/tours/offer-order');
    // Одному из туров без даты — свободная дата: по правилу он встаёт впереди.
    const dated = (await pool.query<{ id: string }>(`SELECT id::text AS id FROM operator_tours WHERE slug = 'w2pt-expensive-7'`)).rows[0].id;
    await pool.query(
      `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled)
       VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kamchatka')::date + 2, 6, FALSE)`, [dated],
    );
    try {
      const storefront = (await pool.query<{ id: string; d: string | null; price: string | null }>(
        `SELECT ot.id::text AS id, ${nearestFreeDateSql('ot')} AS d, ot.base_price::text AS price
           FROM operator_tours ot JOIN partners p ON ot.operator_id = p.id
          WHERE ${publicTourSql('ot')}`,
      )).rows;
      const day = offerOrderDay();
      const listAll = async (sort: string) => {
        const out: string[] = [];
        let total = 0;
        for (let offset = 0; ; offset += 100) {
          const r = await queryMarketplaceTours(MarketplaceToursQuerySchema.parse({ sort, limit: 100, offset }));
          total = r.total;
          out.push(...r.tours.map((t) => String(t.id)));
          if (r.tours.length < 100) break;
        }
        return { out, total };
      };

      const rec = await listAll('recommended');
      expect(rec.total).toBe(storefront.length);
      expect(rec.out).toEqual(orderOffersBy(storefront, (r) => ({ id: r.id, nearestFreeDate: r.d }), { day }).map((r) => r.id));
      expect(rec.out.indexOf(dated)).toBeLessThan(rec.out.indexOf(storefront.find((r) => r.d == null)!.id));

      expect((await listAll('recent')).out).toEqual(rec.out);

      const rule = compareTourOffers(day);
      const byPrice = [...storefront].sort((a, b) => {
        const pa = a.price == null ? null : Number(a.price);
        const pb = b.price == null ? null : Number(b.price);
        if ((pa === null) !== (pb === null)) return pa === null ? 1 : -1;
        if (pa !== null && pb !== null && pa !== pb) return pa - pb;
        return rule({ id: a.id, nearestFreeDate: a.d }, { id: b.id, nearestFreeDate: b.d });
      }).map((r) => r.id);
      expect((await listAll('price_asc')).out).toEqual(byPrice);
    } finally {
      await pool.query(`DELETE FROM tour_availability WHERE operator_tour_id = $1::bigint`, [dated]);
    }
  });

  // ── Правило 1в (слово владельца 29.10): ближайшая свободная дата ─────────
  // Одно условие на все витрины (lib/tours/nearest-free-date). По нему строится
  // порядок, поэтому каждая граница судится здесь, на схеме прода.

  it('ближайшая свободная дата: вчера по Камчатке, отменённая, удалённая, занятая и за год — не даты', async () => {
    const other = '00000000-0000-4000-8000-0000000c4741';
    await pool.query(
      `INSERT INTO partners (id, name, category, contact, slug, is_public, is_verified, status)
       VALUES ($1, 'Ближайшая дата', 'operator', '{}'::jsonb, 'w2pt-nearest', TRUE, TRUE, 'active')`, [other],
    );
    const mk = async (slug: string): Promise<string> => (await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                   min_participants, max_participants, duration_hours, is_active, is_published)
       VALUES ($1, $2, $3, 'nfd_probe', 1000, 'per_person', 1, 4, 8, TRUE, TRUE) RETURNING id::text`,
      [other, `W2PT ближайшая ${slug}`, `w2pt-nearest-${slug}`],
    )).rows[0].id;
    const slot = (tour: string, offset: number, extra: { cancelled?: boolean; deleted?: boolean; slots?: number } = {}) => pool.query(
      `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled, deleted_at)
       VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kamchatka')::date + $2::int, $3, $4, CASE WHEN $5 THEN NOW() ELSE NULL END)`,
      [tour, offset, extra.slots ?? 10, extra.cancelled ?? false, extra.deleted ?? false],
    );
    const day = async (offset: number) => (await pool.query<{ d: string }>(
      `SELECT ((NOW() AT TIME ZONE 'Asia/Kamchatka')::date + $1::int)::text AS d`, [offset],
    )).rows[0].d;

    // A: всё мимо, кроме +5. Вместимость — меньшее из слотов (10) и max_participants (4):
    // бронь на 4 человека занимает +3 целиком, хотя слотов там 10.
    const a = await mk('a');
    await slot(a, -1);
    await slot(a, 1, { cancelled: true });
    await slot(a, 2, { deleted: true });
    await slot(a, 3);
    await pool.query(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, end_date, participants, booking_status)
       VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kamchatka')::date + 3, NULL, 4, 'new')`, [a],
    );
    await slot(a, 5);
    // B: единственная дата — через 13 месяцев, за горизонтом года.
    const b = await mk('b');
    await slot(b, 400);
    // C: календаря нет вовсе — «даты по заявке», свободной даты нет.
    const c = await mk('c');
    // D: сегодня по Камчатке — уже дата.
    const d = await mk('d');
    await slot(d, 0);

    const { nearestFreeDateSql, loadNearestFreeDates } = await import('@/lib/tours/nearest-free-date');
    const rows = (await pool.query<{ id: string; d: string | null }>(
      `SELECT ot.id::text AS id, ${nearestFreeDateSql('ot')} AS d FROM operator_tours ot WHERE ot.id = ANY($1::bigint[])`,
      [[a, b, c, d]],
    )).rows;
    const got = Object.fromEntries(rows.map((r) => [r.id, r.d]));
    expect(got[a]).toBe(await day(5));
    expect(got[b]).toBeNull();
    expect(got[c]).toBeNull();
    expect(got[d]).toBe(await day(0));

    // Каталог сайта судит «даты есть» тем же условием.
    const { hasAvailabilitySql } = await import('@/lib/search/tour-search');
    const has = (await pool.query<{ id: string; h: boolean }>(
      `SELECT ot.id::text AS id, ${hasAvailabilitySql()} AS h FROM operator_tours ot WHERE ot.id = ANY($1::bigint[])`,
      [[a, b, c, d]],
    )).rows;
    expect(Object.fromEntries(has.map((r) => [r.id, r.h]))).toEqual({ [a]: true, [b]: false, [c]: false, [d]: true });

    // Батч — одним запросом; каждому id ответ, неизвестному — null.
    const { pool: appPool } = await import('@/lib/db-pool');
    const spy = vi.spyOn(appPool, 'query');
    try {
      const r = await loadNearestFreeDates([a, b, c, '999999999']);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(r.state).toBe('ok');
      if (r.state === 'ok') {
        expect(r.byId.get(a)).toBe(await day(5));
        expect(r.byId.get(b)).toBeNull();
        expect(r.byId.get(c)).toBeNull();
        expect(r.byId.get('999999999')).toBeNull();
        // Места на ту же дату — потолком max_participants (4), не слотами (10);
        // нет даты — нет и мест (ревью 29.10: карточка маршрута).
        expect(r.seatsById.get(a)).toBe(4);
        expect(r.seatsById.get(b)).toBeNull();
        expect(r.seatsById.get(c)).toBeNull();
      }

      // get_tour_availability на той же сцене (ловушка MCP 29.10,
      // availability-nearest): пустое окно у тура с расписанием называет
      // ближайшую свободную дату тем же движком, что гейт брони, — а не
      // «другой тур», когда «Ближайшая дата» каталога у тура есть.
      const { getTourAvailabilityForKuzmich, yearAhead } = await import('@/lib/kuzmich/tour-availability-tool');
      const { parseAvailabilityText } = await import('@/lib/quality/channel-parity');
      const today = await day(0);
      // Горизонт JS — тот же день, что INTERVAL '1 year' на сервере.
      const horizon = (await pool.query<{ h: string }>(
        `SELECT ((NOW() AT TIME ZONE 'Asia/Kamchatka')::date + INTERVAL '1 year')::date::text AS h`,
      )).rows[0].h;
      expect(yearAhead(today)).toBe(horizon);
      const fmt = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}${iso.slice(0, 4) === today.slice(0, 4) ? '' : `.${iso.slice(0, 4)}`}`;
      const d5 = await day(5);

      // A, окно [0, +2] пусто: после окна +3 занята, +5 свободна — 4 места
      // (потолок max_participants, а не 10 слотов).
      const nearA = await getTourAvailabilityForKuzmich({ tour: a, days: '3' });
      expect(nearA).toContain(`свободных мест с ${fmt(today)} по ${fmt(await day(2))} нет`);
      expect(nearA).toContain(`Ближайшая свободная дата после этого окна — ${fmt(d5)}, свободно 4`);
      expect(nearA).toContain(`date_from=${d5}`);
      expect(nearA).not.toContain(`— ${fmt(await day(3))},`);
      expect(nearA).not.toMatch(/другой тур/);
      // Сверка каналов читает этот ответ как «мест нет», без дат окна.
      expect(parseAvailabilityText(nearA)).toMatchObject({ dates: [], none_free: true });

      // A, окно [+6, +8]: +5 раньше окна названа, «другой тур» не советуется.
      const lateA = await getTourAvailabilityForKuzmich({ tour: a, date_from: await day(6), days: '3' });
      expect(lateA).toContain(`Раньше этого окна есть свободная дата — ${fmt(d5)}, свободно 4`);
      expect(lateA).toContain(`После этого окна до ${fmt(horizon)} свободных дат нет`);
      expect(lateA).not.toMatch(/другой тур/);

      // A на пятерых: на +5 четыре места — не дата для этой группы.
      const groupA = await getTourAvailabilityForKuzmich({ tour: a, days: '3', people: '5' });
      expect(groupA).toContain(`После этого окна до ${fmt(horizon)} свободных дат на 5 чел. нет`);
      expect(groupA).not.toContain(fmt(d5));
      expect(groupA).toMatch(/предложи другой тур/);

      // B: единственная дата за горизонтом — «до горизонта нет», не «вовсе».
      const farB = await getTourAvailabilityForKuzmich({ tour: b, days: '3' });
      expect(farB).toContain(`После этого окна до ${fmt(horizon)} свободных дат нет`);
      expect(farB).not.toMatch(/вовсе/);
      expect(farB).not.toContain(fmt(await day(400)));

      // C без календаря — прежний ответ «по заявке», числа мест нет.
      const onRequest = await getTourAvailabilityForKuzmich({ tour: c });
      expect(onRequest).toContain('расписания в системе нет');
      expect(onRequest).toContain('оператор собирает группу под запрос');
      expect(onRequest).not.toMatch(/свободно \d/);
    } finally {
      spy.mockRestore();
      // Сцена своя и уходит с витрины: следующие сценарии файла считают
      // ближайший выезд и подборки по всей витрине.
      await pool.query(`UPDATE operator_tours SET deleted_at = NOW() WHERE operator_id = $1`, [other]);
    }
  }, 30_000);

  it('ближайшие даты не прочитались — «не смог», а не «дат нет»; SQLSTATE в логе', async () => {
    const { loadNearestFreeDates } = await import('@/lib/tours/nearest-free-date');
    const { pool: appPool } = await import('@/lib/db-pool');
    const spy = vi.spyOn(appPool, 'query').mockRejectedValueOnce(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await loadNearestFreeDates(['1', '2'])).toEqual({ state: 'failed' });
      expect(err.mock.calls.flat().join(' ')).toContain('SQLSTATE=57014');
    } finally {
      spy.mockRestore();
      err.mockRestore();
    }
    // Первый импорт lib/kuzmich/core и сборка подсказки на раннере — секунды.
  }, 30_000);

  // ── #2642: кабинет оператора говорит, видит ли тур турист ─────────────────
  // Список туров ставил бейдж по одному is_active, экран «Чего не хватает» —
  // по одному is_published. Теперь оба читают ответ того же шлюза
  // (publicTourSql AS on_storefront) и называют состояние storefrontState.

  it('карточка тура (getTourForCard) несёт подписи снимков из карты партнёра (26.10)', async () => {
    const shot = '/images/w2pt/shot-1.jpg';
    await pool.query(`UPDATE operator_tours SET photos = ARRAY[$2::text] WHERE id = $1::bigint`, [id.live, shot]);
    await pool.query(
      `UPDATE partners SET gallery_credits = jsonb_build_object($2::text, 'Автор W2PT') WHERE id = $1::uuid`,
      [OPERATOR.id, shot],
    );
    const { getTourForCard } = await import('@/lib/tours/tour-detail-query');
    const { tourPhotoCaptions } = await import('@/lib/tours/photo-credits');
    const card = await getTourForCard(Number(id.live));
    expect(card).not.toBeNull();
    expect(tourPhotoCaptions(card!.photos ?? [], card!.operator_photo_credits)).toEqual(['Фото: Автор W2PT']);
  });

  it('кабинет (#2642): on_storefront и состояние тура совпадают с выдачей каталога на каждом туре', async () => {
    const { getToursByOperator } = await import('@/lib/api/operator-tours');
    const { COMPLETENESS_TOURS_SQL } = await import('@/lib/operator/screen-queries');
    const { queryMarketplaceTours, MarketplaceToursQuerySchema } = await import('@/lib/search/tour-search');
    const { storefrontState } = await import('@/lib/tours/public-visibility');
    type Row = { id: string | number; is_active: boolean | null; is_published: boolean | null; on_storefront: boolean };

    const list = (await getToursByOperator(OPERATOR.id, { limit: 100, offset: 0 })).rows as unknown as Row[];
    const screenRows = (await pool.query<Row>(COMPLETENESS_TOURS_SQL, [OPERATOR.id])).rows;
    // Удалённый тур кабинет не показывает вовсе — ни списком, ни экраном.
    const inCabinet = [id.live, id.live2, id.inactive, id.unpublished].sort();
    expect(list.map((r) => String(r.id)).sort()).toEqual(inCabinet);
    expect(screenRows.map((r) => String(r.id)).sort()).toEqual(inCabinet);

    const expected: Record<string, 'on' | 'draft' | 'hidden'> = {
      [id.live]: 'on', [id.live2]: 'on', [id.inactive]: 'hidden', [id.unpublished]: 'draft',
    };
    for (const [where, rows] of [['список туров', list], ['экран «Чего не хватает»', screenRows]] as const) {
      for (const r of rows) {
        const tid = String(r.id);
        const found = await queryMarketplaceTours(MarketplaceToursQuerySchema.parse({ id: tid, limit: 10 }));
        const inCatalog = found.tours.some((t) => String(t.id) === tid);
        expect(typeof r.on_storefront, `${where}: ${tid}`).toBe('boolean');
        expect(r.on_storefront, `${where}: on_storefront тура ${tid} против каталога`).toBe(inCatalog);
        // Копия условия в функции равна шлюзу: одни флаги дают тот же итог.
        expect(storefrontState({ is_active: r.is_active, is_published: r.is_published }) === 'on', `${where}: флаги ${tid}`).toBe(inCatalog);
        expect(storefrontState(r), `${where}: ${tid}`).toBe(expected[tid]);
      }
    }
  });

  it('кабинет (#2642): «Готов к Авито и Яндексу» — ровно туры из ленты; черновик со всеми полями — нет', async () => {
    // Поля лент заполнены у всех туров оператора: решает только витрина.
    await pool.query(`UPDATE partners SET contacts = '{"phone":"+70000000001"}'::jsonb WHERE id = $1`, [OPERATOR.id]);
    await pool.query(
      `UPDATE operator_tours
          SET description = repeat('Описание тура для лент площадок. ', 15),
              photos = ARRAY['/images/w2pt-cover.jpg'],
              pickup_type = 'hotel_pickup',
              cancellation_policy = 'Бесплатная отмена за 3 дня до тура',
              latitude = 53.25, longitude = 158.83
        WHERE operator_id = $1`,
      [OPERATOR.id],
    );
    const { getOperatorPartnerId } = await import('@/lib/auth/operator-helpers');
    vi.mocked(getOperatorPartnerId).mockResolvedValueOnce(OPERATOR.id);
    const { GET } = await import('@/app/api/operator/completeness/route');
    const res = await GET(new NextRequest('http://localhost/api/operator/completeness'));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { tours: Array<{ tour_id: string | number; on_storefront: boolean; marketplace_ready: boolean; marketplace_blockers: unknown[] }> };
    };
    const byId = Object.fromEntries(body.data.tours.map((t) => [String(t.tour_id), t]));
    expect(Object.keys(byId).sort()).toEqual([id.live, id.live2, id.inactive, id.unpublished].sort());

    const { selectFeedTours } = await import('@/lib/channels/ready-tours');
    const feed = new Set((await selectFeedTours()).tours.map((t) => String(t.id)));
    for (const [tid, t] of Object.entries(byId)) {
      expect(t.marketplace_blockers, `у тура ${tid} поля лент заполнены`).toEqual([]);
      expect(t.marketplace_ready, `«готов» тура ${tid} против ленты`).toBe(feed.has(tid));
    }
    expect(byId[id.unpublished]).toMatchObject({ on_storefront: false, marketplace_ready: false });
    expect(byId[id.live]).toMatchObject({ on_storefront: true, marketplace_ready: true });
  });

  // ── Ревью #2642: «Черновик — туристы не видят» — правда на каждом отборе ──
  // Кабинет подписывает черновик «туристы не видят». Ревью нашло три отбора
  // для туриста, судивших по is_active/deleted_at без is_published: поиск
  // /api/discovery/search, фид Meta и подбор туров в предложение по лиду; перепись
  // нашла ещё. Здесь черновик (и выключенный, и удалённый) спрашивается у
  // каждого из них на настоящей базе: мок ответил бы на любой SQL.
  describe('черновик не уходит туристу (ревью #2642)', () => {
    const ours = (ids: Array<string | number | null | undefined>) =>
      ids.map((x) => String(x)).filter((x) => STATES.some((s) => id[s] === x)).sort();
    const title = (s: State) => `W2PT тур ${s}`;
    let d1 = '';
    let d2 = '';
    let d3 = '';

    beforeAll(async () => {
      // Поля, без которых отборы отказали бы туру по другим причинам: AI-теги
      // для поиска по тегам, тип места для OCTO. Даты: на первую — только
      // снятые туры, на вторую — живые, на третью — все пять.
      await pool.query(
        `UPDATE operator_tours
            SET ai_tags = '{"landscape":["w2pt_land"]}'::jsonb,
                location_type = 'volcano'
          WHERE operator_id = $1`,
        [OPERATOR.id],
      );
      const dates = (await pool.query<{ d1: string; d2: string; d3: string }>(
        `SELECT (CURRENT_DATE + 3)::text AS d1, (CURRENT_DATE + 4)::text AS d2, (CURRENT_DATE + 5)::text AS d3`,
      )).rows[0];
      ({ d1, d2, d3 } = dates);
      for (const s of STATES) {
        const live = s === 'live' || s === 'live2';
        for (const day of [live ? d2 : d1, d3]) {
          await pool.query(
            `INSERT INTO tour_availability (operator_tour_id, date, available_slots) VALUES ($1, $2::date, 8)`,
            [id[s], day],
          );
        }
      }
    });

    it('GET /api/discovery/search: ни ветка AI-тегов, ни поиск по словам черновика не находят', async () => {
      const { GET } = await import('@/app/api/discovery/search/route');
      type Body = { success: boolean; data: Array<{ id: string | number }> };
      const ask = async (qs: string) => {
        const res = await GET(new NextRequest(`http://localhost/api/discovery/search?${qs}`));
        expect(res.status, qs).toBe(200);
        return ours(((await res.json()) as Body).data.map((t) => t.id));
      };
      expect(await ask('landscape=w2pt_land&limit=100'), 'ветка ai_tags').toEqual(live());
      expect(await ask(`q=${encodeURIComponent('W2PT тур')}&limit=100`), 'поиск по словам').toEqual(live());
      expect(await ask(`q=${encodeURIComponent('W2PT тур')}&limit=100&advanced=true`), 'расширенный').toEqual(live());
    });

    it('вход на границах проверки (ревью #2642, третий круг): что пропустила проверка, база выполняет', async () => {
      // Проверка входа стоит до базы; здесь — что граничные значения, которые
      // она пропускает, база принимает: дробная цена против numeric, последняя
      // страница при самом большом размере, день и месяц на краю календаря.
      const search = (await import('@/app/api/discovery/search/route')).GET;
      type Body = { success: boolean; data: Array<{ id: string | number }> };
      const ask = async (qs: string) => {
        const res = await search(new NextRequest(`http://localhost/api/discovery/search?${qs}`));
        expect(res.status, qs).toBe(200);
        return ours(((await res.json()) as Body).data.map((t) => t.id));
      };
      const q = `q=${encodeURIComponent('W2PT тур')}`;
      // Цена туров 1000: «до 1000.5» — оба живых, «от 1000.5» — ни одного.
      expect(await ask(`${q}&limit=100&page=1&minPrice=0&maxPrice=1000.5&rating=0`)).toEqual(live());
      expect(await ask(`${q}&limit=100&minPrice=1000.5`)).toEqual([]);
      expect(await ask(`${q}&limit=100&page=10000`)).toEqual([]);
      expect(await ask(`landscape=w2pt_land&limit=1&page=10000`)).toEqual([]);
      expect(await ask(`landscape=w2pt_land&limit=100&page=1`)).toEqual(live());

      const day = (await import('@/app/api/availability/day/route')).GET;
      expect((await day(new NextRequest('http://localhost/api/availability/day?date=9999-12-31'))).status).toBe(200);
      expect((await day(new NextRequest('http://localhost/api/availability/day?date=2096-02-29'))).status).toBe(200);
      const month = (await import('@/app/api/availability/route')).GET;
      expect((await month(new NextRequest('http://localhost/api/availability?month=9999-12'))).status).toBe(200);
    });

    it('подсказки и подборки поиска (searchService): автодополнение, рекомендованные, тренды, теги, похожие', async () => {
      const { searchService } = await import('@/lib/services');
      const titles = (await searchService.autocomplete('W2PT тур', 50)).filter((t) => t.startsWith('W2PT тур ')).sort();
      expect(titles).toEqual([title('live'), title('live2')]);
      const idOf = (rows: unknown[]) => ours(rows.map((r) => (r as { id: string | number }).id));
      expect(idOf(await searchService.getRecommended(50, OPERATOR.id))).toEqual(live());
      expect(idOf(await searchService.getTrending(50))).toEqual(live());
      expect(idOf(await searchService.getSimilar(id.live, 20))).toEqual([id.live2]);
      const tags = (await searchService.getPopularTags(100)).map((t) => t.tag).filter((t) => t.startsWith('w2pt_')).sort();
      expect(tags).toEqual([activity('live'), activity('live2')]);
    });

    it('фид Meta (/api/meta/catalog): только туры витрины', async () => {
      const { GET } = await import('@/app/api/meta/catalog/route');
      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json() as { data: Array<{ id: string }> };
      expect(ours(body.data.map((p) => p.id.replace(/^tour_/, '')))).toEqual(live());
    });

    it('подбор туров в предложение по лиду (matchTours): черновика нет', async () => {
      const { leadProcessor } = await import('@/lib/services/operators/lead-processor.service');
      // Метод закрыт, а судится он сам — без ИИ-квалификации вокруг.
      const match = (leadProcessor as unknown as {
        matchTours: (i: unknown, r: string | null, op: string | null) => Promise<Array<{ id: string }>>;
      }).matchTours.bind(leadProcessor);
      const intent = {
        activity_types: STATES.map(activity), group_size: null, budget_rub: null, desired_dates: null,
        duration_days: null, interests: [], urgency: 'low', qualification_notes: '',
      };
      expect(ours((await match(intent, null, OPERATOR.id)).map((t) => t.id))).toEqual(live());
    });

    it('календарь дат (/api/availability, /day) и плашка «ближайший выезд»: только туры витрины', async () => {
      const day = await import('@/app/api/availability/day/route');
      const dayRes = await day.GET(new NextRequest(`http://localhost/api/availability/day?date=${d3}`));
      const dayBody = await dayRes.json() as { tours: Array<{ tourId: number }> };
      expect(dayRes.status, JSON.stringify(dayBody)).toBe(200);
      expect(ours(dayBody.tours.map((t) => t.tourId))).toEqual(live());

      const month = await import('@/app/api/availability/route');
      for (const s of STATES) {
        const res = await month.GET(new NextRequest(`http://localhost/api/availability?month=${d3.slice(0, 7)}&activity=${activity(s)}`));
        const body = await res.json() as { days: Array<{ date: string }> };
        const live1 = s === 'live' || s === 'live2';
        expect(body.days.map((x) => x.date).sort(), s).toEqual(live1 ? [d2, d3].filter((x) => x.slice(0, 7) === d3.slice(0, 7)).sort() : []);
      }

      // Снятые туры выезжают раньше живых: прежняя копия без is_published
      // назвала бы ближайшим выездом черновик. Погода — чужой сервис, здесь она
      // не нужна.
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('сеть в тесте не нужна'));
      try {
        const now = await import('@/app/api/public/now/route');
        const body = await (await now.GET()).json() as { data: { nextDeparture: { tourName: string; date: string } | null } };
        expect(body.data.nextDeparture?.tourName).toBe(title('live'));
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('подборка по ссылке (/api/p/[code]): черновик, выключенный и удалённый тур клиент не видит', async () => {
      const sel = (await pool.query<{ id: string }>(
        `INSERT INTO tour_selections (code, title, operator_id) VALUES ('w2ptsel', 'W2PT подборка', $1) RETURNING id::text`,
        [OPERATOR.id],
      )).rows[0];
      let pos = 0;
      for (const s of STATES) {
        await pool.query(
          `INSERT INTO tour_selection_items (selection_id, operator_tour_id, position) VALUES ($1::uuid, $2::int, $3)`,
          [sel.id, id[s], pos++],
        );
      }
      const { GET } = await import('@/app/api/p/[code]/route');
      const res = await GET(new NextRequest('http://localhost/api/p/w2ptsel'), { params: Promise.resolve({ code: 'w2ptsel' }) });
      expect(res.status).toBe(200);
      const body = await res.json() as { tours: Array<{ tour_id: number }> };
      expect(ours(body.tours.map((t) => t.tour_id))).toEqual(live());
    });

    it('OCTO для реселлеров: продукт и список продуктов — только туры витрины', async () => {
      const octo = await import('@/lib/octo/service');
      for (const s of STATES) {
        const live1 = s === 'live' || s === 'live2';
        expect(await octo.getProductById(id[s]) !== null, `getProductById ${s}`).toBe(live1);
      }
      expect(ours((await octo.getProducts(OPERATOR.id)).map((p) => (p as { id: string | number }).id))).toEqual(live());
    });
  });

  it('витрина Кузьмича (loadShowcaseTours): вулкан после 400-го знака описания — тур в ответе (находка 24.10)', async () => {
    // Запрос искал вулкан по описанию целиком, а отбор в коде — по обрезанному
    // до 400 знаков: тур, найденный базой, выкидывался, и туристу говорили
    // «нет живого тура к этому вулкану». Свой тур заводится и убирается здесь.
    const description = `${'Выезд из города на джипах по грунтовке. '.repeat(12)}К вечеру — подножие Мутновского вулкана.`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                   min_participants, max_participants, duration_hours, difficulty,
                                   is_active, is_published, description, season_start, season_end)
       VALUES ($1, 'W2PT джип выходного дня', 'w2pt-jeep-weekend', 'jeep', 1000, 'per_person', 1, 10, 8, 'easy',
               TRUE, TRUE, $2, '2026-06-01', '2026-12-31')
       RETURNING id::text`,
      [OPERATOR.id, description],
    );
    try {
      const { loadShowcaseTours, pickToursForAnswer } = await import('@/lib/telegram/tourist-tours');
      const question = 'туры на Мутновский вулкан';
      const loaded = await loadShowcaseTours(question);
      expect(loaded.ok).toBe(true);
      const tours = loaded.ok ? loaded.tours : [];
      expect(tours.map((t) => t.slug)).toContain('w2pt-jeep-weekend');
      // Описание в строке обрезано — вулкана в нём нет; судит текст поиска.
      expect(tours.find((t) => t.slug === 'w2pt-jeep-weekend')?.description ?? '').not.toMatch(/мутнов/i);
      const picked = pickToursForAnswer(question, loaded, new Date('2026-10-24T00:00:00Z'));
      expect(picked.kind).toBe('list');
      expect(picked.tours.map((t) => t.slug)).toEqual(['w2pt-jeep-weekend']);
    } finally {
      await pool.query(`DELETE FROM operator_tours WHERE id::text = $1`, [rows[0].id]);
    }
  });

  // ── Полнота поиска туров Кузьмича: три компании к одному месту (29.10) ──
  // Шаг 1 разбора «мозг Кузьмича при росте каталога»: база «до» без модели.
  // На «все туры к Толбачику» на проде шесть туров четырёх компаний, и
  // сравнивать устройство поиска можно, только зная, что каждый путь отдаёт
  // сегодня. Пути, отдающие не всё, записаны в KNOWN_INCOMPLETE с причиной и
  // нынешним числом: починит их ветка multi-offer — запись обязана уйти, тест
  // покраснеет на старом числе (самоустаревает, как KNOWN_UNPRODUCED).
  it('поиск туров Кузьмича: девять туров трёх компаний к одному месту и десятый по явной связи — что отдаёт каждый путь (29.10)', async () => {
    const PLACE = 'Пробный';
    const companies = [
      { id: 'b1100000-0000-4000-8000-0000000000c1', name: 'W2PT Компания Альфа', slug: 'w2pt-alpha' },
      { id: 'b1100000-0000-4000-8000-0000000000c2', name: 'W2PT Компания Бета', slug: 'w2pt-beta' },
      { id: 'b1100000-0000-4000-8000-0000000000c3', name: 'W2PT Компания Гамма', slug: 'w2pt-gamma' },
    ];
    const KNOWN_INCOMPLETE = {
      // resolveTourByQuery: «LIMIT 1» — на слово места один тур одной компании.
      get_tour_details: { gives: 1, why: 'resolveTourByQuery отдаёт один тур (LIMIT 1); ветка multi-offer' },
      // toursMentioningPlace: «.slice(0, 3)» — к прайсу машин едут три тура места.
      search_transfers: { gives: 3, why: 'toursMentioningPlace режет туры места до трёх строк' },
      // filterTourCatalog сравнивает по основе слова: опечатка в окончании
      // прощается, внутри основы — нет.
      get_tours_typo_inside_stem: { starts: 'Туров «прабный» у операторов платформы сейчас нет', why: 'опечатка внутри основы слова: get_tours сравнивает по основе' },
      // Тур связан с местом явно (operator_tours.main_place_id, миграция 1286),
      // но слова места в его тексте нет. Каталог Кузьмича (loadTourCatalog)
      // колонку не читает, фильтр судит по тексту строки — тура не видит ни
      // get_tours, ни поиск машин к месту. Эталон коммерческого эвала — тот же
      // get_tours, так что эвал этого пробела не видит тоже (ревью 29.10).
      get_tours_main_place_id: { listed: false, why: 'связь по main_place_id не читается каталогом Кузьмича: тур без слова места в тексте не находится' },
      search_transfers_main_place_id: { listed: false, why: 'toursMentioningPlace ищет по тексту, main_place_id не читает' },
    } as const;
    const PLACE_ID = 'w2pt-probe-place';
    await pool.query(
      `INSERT INTO places (id, name, lat, lng, location_type, is_visible) VALUES ($1, $2, 55.83, 160.33, 'volcano', TRUE)`,
      [PLACE_ID, `Вулкан ${PLACE}`],
    );
    const tourIds: string[] = [];
    for (const [ci, c] of companies.entries()) {
      await pool.query(
        `INSERT INTO partners (id, name, category, contact, slug, is_public, is_verified, status)
         VALUES ($1, $2, 'operator', '{}'::jsonb, $3, TRUE, TRUE, 'active')`,
        [c.id, c.name, c.slug],
      );
      for (const [ki, kind] of ['jeep_safari', 'helicopter', 'trekking'].entries()) {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                       min_participants, max_participants, duration_hours, difficulty,
                                       is_active, is_published, location_name)
           VALUES ($1, $2, $3, $4, $5, 'per_person', 1, 8, 8, 'easy', TRUE, TRUE, $6)
           RETURNING id::text`,
          [c.id, `W2PT ${PLACE} ${c.slug} ${kind}`, `w2pt-probe-${c.slug}-${ki}`, kind, 2000 + ci * 10 + ki, `Вулкан ${PLACE}`],
        );
        tourIds.push(rows[0].id);
      }
    }
    // Десятый тур: место — только явной связью, без слова места в тексте.
    const { rows: linkedRows } = await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                   min_participants, max_participants, duration_hours, difficulty,
                                   is_active, is_published, location_name, main_place_id)
       VALUES ($1, 'W2PT Лавовые поля и Мёртвый лес', 'w2pt-probe-linked', 'trekking', 2100, 'per_person',
               1, 8, 8, 'easy', TRUE, TRUE, 'Ключи', $2)
       RETURNING id::text`,
      [companies[0].id, PLACE_ID],
    );
    const linkedId = linkedRows[0].id;
    const all = [...tourIds].sort();
    const idsIn = (text: string) => [...text.matchAll(/^ID(\d+):/gm)].map((m) => m[1]).filter((x) => all.includes(x)).sort();

    // Кэш каталога живёт 3 минуты, и прежний тест уже сдвигал часы на 10 —
    // вперёд дальше, чтобы каталог прочитался с новыми турами.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    try {
      const { executeKuzmichTool } = await import('@/lib/kuzmich/core');

      // get_tours в чате: по слову места — все девять, у каждого компания.
      const chat = await executeKuzmichTool('get_tours', { activity_type: PLACE });
      expect(idsIn(chat)).toEqual(all);
      // Тур живой и в каталоге есть — по своему слову находится.
      expect(await executeKuzmichTool('get_tours', { activity_type: 'Лавовые' })).toContain(`ID${linkedId}:`);
      // По слову места — нет: известный пробел, записан, а не спрятан.
      expect(chat.includes(`ID${linkedId}:`), KNOWN_INCOMPLETE.get_tours_main_place_id.why)
        .toBe(KNOWN_INCOMPLETE.get_tours_main_place_id.listed);
      for (const c of companies) expect(chat.match(new RegExp(`Оп: ${c.name}`, 'g'))).toHaveLength(3);

      // MCP: страницами по семь — первая неполная и называет, сколько всего;
      // две страницы вместе — все девять.
      const p1 = await executeKuzmichTool('get_tours', { activity_type: PLACE }, { surface: 'mcp' });
      const p2 = await executeKuzmichTool('get_tours', { activity_type: PLACE, page: '2' }, { surface: 'mcp' });
      expect(idsIn(p1)).toHaveLength(7);
      expect(p1).toContain('Страница 1 из 2, туров всего 9.');
      expect([...idsIn(p1), ...idsIn(p2)].sort()).toEqual(all);

      // «Что есть у компании»: слово туриста — имя компании; отдаются её три
      // тура, чужих нет (совпадение по строке «Оп:», не отдельный фильтр).
      const beta = companies[1];
      const betaIds = tourIds.slice(3, 6).sort();
      const byCompany = await executeKuzmichTool('get_tours', { activity_type: 'Компания Бета' });
      expect(idsIn(byCompany)).toEqual(betaIds);
      expect(byCompany.match(new RegExp(`Оп: ${beta.name}`, 'g'))).toHaveLength(3);

      // Опечатка в окончании («пробнай») — основа та же, все девять.
      expect(idsIn(await executeKuzmichTool('get_tours', { activity_type: 'пробнай' }))).toEqual(all);
      // Опечатка внутри основы («прабный») — инструмент туров не находит и
      // честно говорит «туров нет» (каталог следом — замена с оговоркой):
      // исправлять слово остаётся модели. Записано как пробел, а не спрятано.
      const typoInside = await executeKuzmichTool('get_tours', { activity_type: 'прабный' });
      expect(typoInside.startsWith(KNOWN_INCOMPLETE.get_tours_typo_inside_stem.starts), KNOWN_INCOMPLETE.get_tours_typo_inside_stem.why)
        .toBe(true);

      // Известные пробелы — нынешнее число, не спрятанное «всё хорошо».
      const details = await executeKuzmichTool('get_tour_details', { name: PLACE });
      const detailsTours = all.filter((tid) => details.includes(`/tours/${tid}`) || details.includes(`ID${tid}`));
      const titlesInDetails = companies.flatMap((c) => ['jeep_safari', 'helicopter', 'trekking']
        .map((k) => `W2PT ${PLACE} ${c.slug} ${k}`)).filter((t) => details.includes(t));
      expect(titlesInDetails.length, `${KNOWN_INCOMPLETE.get_tour_details.why} (ids ${detailsTours.join(',')})`)
        .toBe(KNOWN_INCOMPLETE.get_tour_details.gives);

      const transfers = await executeKuzmichTool('search_transfers', { place: PLACE });
      expect(idsIn(transfers).length, KNOWN_INCOMPLETE.search_transfers.why).toBe(KNOWN_INCOMPLETE.search_transfers.gives);
      expect(transfers.includes(`ID${linkedId}:`), KNOWN_INCOMPLETE.search_transfers_main_place_id.why)
        .toBe(KNOWN_INCOMPLETE.search_transfers_main_place_id.listed);
    } finally {
      vi.useRealTimers();
      await pool.query(`DELETE FROM operator_tours WHERE id::text = ANY($1::text[])`, [[...tourIds, linkedId]]);
      await pool.query(`DELETE FROM places WHERE id = $1`, [PLACE_ID]);
      await pool.query(`DELETE FROM partners WHERE id = ANY($1::uuid[])`, [companies.map((c) => c.id)]);
    }
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
      // Места, главные ТОЛЬКО у непубличных туров: шлюз витрины в ветке
      // главного места не даёт им ни «Туров сюда», ни китайской страницы.
      ['tp-place-draft-only', 59.2, 164.2, true],
      ['tp-place-gone', 59.4, 164.4, true],
      ['tp-place-off', 59.6, 164.6, true],
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
        ['tp-draft', 59.2, 164.2, false, null],               // черновик: связь есть, витрины нет
        ['tp-preset', 52.4321, 158.1234, true, 'tp-place-pick'], // выбор оператора не перетирается
        ['tp-nearby', null, null, true, null],                // только «рядом» по маршруту
        ['tp-both', 56.1, 161.1, true, null],                 // маршрут и главное место — одно место
        ['tp-deleted', null, null, true, 'tp-place-gone'],    // удалён оператором (deleted_at)
        ['tp-off', null, null, true, 'tp-place-off'],         // выключен (is_active = false)
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
      await pool.query(`UPDATE operator_tours SET deleted_at = NOW() WHERE slug = 'tp-deleted'`);
      await pool.query(`UPDATE operator_tours SET is_active = FALSE WHERE slug = 'tp-off'`);
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
        'tp-draft': ['tp-place-draft-only', 'coords_equal'],
        'tp-preset': ['tp-place-pick', 'operator'],
        'tp-nearby': [null, null],
        'tp-both': ['tp-place-vis', 'coords_equal'],
        'tp-deleted': ['tp-place-gone', 'operator'],
        'tp-off': ['tp-place-off', 'operator'],
      };
      const snapshot = async () => Object.fromEntries(await Promise.all(Object.keys(expected).map(async (slug) => {
        const l = await linkOf(slug);
        return [slug, [l.main_place_id, l.main_place_source]] as const;
      })));
      expect(await snapshot()).toEqual(expected);
      await pool.query(migration);
      expect(await snapshot()).toEqual(expected);
      // Источник — только из четырёх названных (1286 + 1344: verified, admin).
      await expect(pool.query(`UPDATE operator_tours SET main_place_source = 'guess' WHERE slug = 'tp-exact'`))
        .rejects.toMatchObject({ code: '23514' });
    });

    it('«Туры сюда»: тур по главному месту — «к этому месту»; черновик, удалённый, выключенный и «рядом» — нет', async () => {
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
      // Главное место только у черновика, удалённого или выключенного тура — туров нет.
      for (const pid of ['tp-place-draft-only', 'tp-place-gone', 'tp-place-off']) {
        expect(await card(pid), pid).toEqual([]);
      }
    });

    it('китайские конспекты: место по главному месту живого тура — да; «рядом», без связи и непубличный тур — нет', async () => {
      const { loadZhPlaceSources } = await import('@/lib/zh/content');
      const ids = (await loadZhPlaceSources()).map((p) => p.id);
      expect(ids).toEqual(expect.arrayContaining(['tp-place-exact', 'tp-place-vis', 'tp-place-pick']));
      // Место, главное только у непубличного тура (черновик, удалён, выключен), —
      // не страница: шлюз витрины держит и ветку главного места.
      for (const no of ['tp-place-nearby', 'tp-place-twin-a', 'tp-place-twin-b', 'tp-place-near', 'tp-place-hidden',
        'tp-place-draft-only', 'tp-place-gone', 'tp-place-off']) {
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

    // ── 29.10, «1в 2б 3 да»: все туры места, по правилу 1в ───────────────────
    it('туры места (loadPlaceTours): все, без LIMIT 5, через шлюз витрины, «рядом» нет, ближайшая дата есть', async () => {
      await pool.query(
        `INSERT INTO places (id, ark_id, name, slug, lat, lng, is_visible, location_type)
         VALUES ('tp-place-many', gen_random_uuid(), 'Место многих туров', 'tp-place-many', 59.9, 164.9, TRUE, 'volcano')`,
      );
      const ids: string[] = [];
      for (let i = 1; i <= 7; i++) {
        ids.push((await pool.query<{ id: string }>(
          `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                       min_participants, max_participants, duration_hours, is_active, is_published,
                                       main_place_id, main_place_source)
           VALUES ($1, $2, $3, 'tp_many', 5000, 'per_person', 1, 10, 8, TRUE, TRUE, 'tp-place-many', 'operator')
           RETURNING id::text`,
          [TP.id, `TP многих ${i}`, `tp-many-${i}`],
        )).rows[0].id);
      }
      // Черновик к тому же месту — не на витрине.
      await pool.query(
        `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                     min_participants, max_participants, duration_hours, is_active, is_published,
                                     main_place_id, main_place_source)
         VALUES ($1, 'TP многих черновик', 'tp-many-draft', 'tp_many', 5000, 'per_person', 1, 10, 8, TRUE, FALSE, 'tp-place-many', 'operator')`,
        [TP.id],
      );
      // У пятого — свободная дата через 10 дней: он первым по правилу.
      await pool.query(
        `INSERT INTO tour_availability (operator_tour_id, date, available_slots)
         VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kamchatka')::date + 10, 5)`, [ids[4]],
      );
      const { loadPlaceTours } = await import('@/lib/places/place-tours');
      const r = await loadPlaceTours('tp-place-many');
      expect(r.state).toBe('ok');
      if (r.state !== 'ok') return;
      expect(r.offers.map((o) => o.id).sort()).toEqual([...ids].sort());
      expect(r.offers[0].id).toBe(ids[4]);
      expect(r.offers[0].nearestFreeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.offers[0].keepsSchedule).toBe(true);
      expect(r.offers.slice(1).every((o) => o.nearestFreeDate === null && o.keepsSchedule === false && o.hasDatesByRequest)).toBe(true);
      expect(r.offers[0]).toMatchObject({ partnerId: TP.id, partnerName: TP.name, partnerVerified: true, basePrice: 5000, priceUnit: 'per_person' });
      // Порядок — правило 1в на тех же строках и том же дне.
      const { orderOffers } = await import('@/lib/tours/offer-order');
      expect(r.offers.map((o) => o.id)).toEqual(orderOffers(r.offers, { day: r.day }).map((o) => o.id));

      // «Рядом» и туров нет — «пусто», не «сбой».
      expect((await loadPlaceTours('tp-place-nearby')).state).toBe('empty');

      // Карточка места: семь туров, а не пять; день правила — тот же.
      const { loadPlaceDetail } = await import('@/lib/places/place-detail');
      const card = (await loadPlaceDetail('tp-place-many', { countView: false })).body.data as { tours: unknown[]; toursState: string; toursDay: string };
      expect(card.tours).toHaveLength(7);
      expect(card.toursState).toBe('ok');
      expect(card.toursDay).toBe(r.day);
    });

    it('туры места не прочитались — «failed» и SQLSTATE в логе; карточка места отвечает 200', async () => {
      const { loadPlaceTours } = await import('@/lib/places/place-tours');
      const { pool: appPool } = await import('@/lib/db-pool');
      const spy = vi.spyOn(appPool, 'query').mockRejectedValueOnce(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) as never);
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(await loadPlaceTours('tp-place-many')).toEqual({ state: 'failed' });
        expect(err.mock.calls.find((c) => String(c[0]).includes('[place-tours]'))?.[1]).toMatchObject({ sqlstate: '57014' });
      } finally {
        spy.mockRestore();
        err.mockRestore();
      }
    });

    it('1344: связи по сверке названий; выбор человека не тронут; облёт снят; переименованное место — нет; повтор ничего не меняет', async () => {
      const m1344 = readFileSync(join(process.cwd(), 'migrations', '1344_tour_main_place_verified.sql'), 'utf8');
      // Места — с id и именами из списка 1344; одно переименовано.
      const PL: Array<[string, string]> = [
        ['2886ce3b-0753-41fb-bacc-f80e3f75d1aa', 'Вулкан Горелый'],
        ['2bf92082-0daf-4770-8031-a51c0f355be8', 'Дачные горячие источники'],
        ['c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe', 'Вачкажец (переименовано)'],
        ['tp-place-vilyuchinsky', 'Вулкан Вилючинский'],
      ];
      for (const [pid, name] of PL) {
        await pool.query(
          `INSERT INTO places (id, ark_id, name, slug, lat, lng, is_visible, location_type)
           VALUES ($1::text, gen_random_uuid(), $2::text, $1::text, 52.7, 158.3, TRUE, 'volcano')
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, is_visible = TRUE, merged_into_id = NULL`,
          [pid, name],
        );
      }
      const T = {
        gorelyM: 'mestechko-vulkan-gorelyy',
        gorelyZ: 'zaporozhets-vulkan-gorelyy',
        preset: 'lagexp-dachnye-goryachie-istochniki-na-vnedorozhnike-tank-300',
        oblet: 'mestechko-oblet-vilyuchinskiy-mutnovskiy-gorelyy',
        renamed: 'mestechko-vachkazhets',
      };
      const present = (await pool.query<{ slug: string }>(
        `SELECT slug FROM operator_tours WHERE slug = ANY($1::text[]) AND deleted_at IS NULL`, [Object.values(T)],
      )).rows.map((x) => x.slug).sort();
      // Туры заведены миграциями 1217, 1338, 1339 при постройке схемы — сцена на них.
      expect(present).toEqual(Object.values(T).sort());
      await pool.query(
        `UPDATE operator_tours SET main_place_id = NULL, main_place_source = NULL WHERE slug = ANY($1::text[])`,
        [[T.gorelyM, T.gorelyZ, T.renamed]],
      );
      await pool.query(`UPDATE operator_tours SET main_place_id = 'tp-place-pick', main_place_source = 'operator' WHERE slug = $1`, [T.preset]);
      await pool.query(`UPDATE operator_tours SET main_place_id = 'tp-place-vilyuchinsky', main_place_source = 'coords_equal' WHERE slug = $1`, [T.oblet]);

      await pool.query(m1344);
      const snap = async () => Object.fromEntries((await pool.query<{ slug: string; main_place_id: string | null; main_place_source: string | null }>(
        `SELECT slug, main_place_id, main_place_source FROM operator_tours WHERE slug = ANY($1::text[])`, [Object.values(T)],
      )).rows.map((x) => [x.slug, [x.main_place_id, x.main_place_source]]));
      const expected = {
        [T.gorelyM]: ['2886ce3b-0753-41fb-bacc-f80e3f75d1aa', 'verified'],
        [T.gorelyZ]: ['2886ce3b-0753-41fb-bacc-f80e3f75d1aa', 'verified'],
        [T.preset]: ['tp-place-pick', 'operator'],
        [T.oblet]: [null, null],
        [T.renamed]: [null, null],
      };
      expect(await snap()).toEqual(expected);
      await pool.query(m1344);
      expect(await snap()).toEqual(expected);
      // Связь, поставленная человеком на облёт, повтором не снимается.
      await pool.query(`UPDATE operator_tours SET main_place_id = 'tp-place-vilyuchinsky', main_place_source = 'admin' WHERE slug = $1`, [T.oblet]);
      await pool.query(m1344);
      expect((await snap())[T.oblet]).toEqual(['tp-place-vilyuchinsky', 'admin']);
      await expect(pool.query(`UPDATE operator_tours SET main_place_source = 'guess' WHERE slug = $1`, [T.gorelyM]))
        .rejects.toMatchObject({ code: '23514' });

      // Карточка Горелого: два тура разных компаний.
      const { loadPlaceTours } = await import('@/lib/places/place-tours');
      const r = await loadPlaceTours('2886ce3b-0753-41fb-bacc-f80e3f75d1aa');
      expect(r.state).toBe('ok');
      if (r.state === 'ok') {
        expect(r.offers.map((o) => o.slug).sort()).toEqual([T.gorelyM, T.gorelyZ].sort());
        expect(new Set(r.offers.map((o) => o.partnerId)).size).toBe(2);
      }
    });

    it('слияние мест (carryTourMainPlace): тур едет к оставшемуся месту, источник сохраняется', async () => {
      await pool.query(
        `INSERT INTO places (id, ark_id, name, slug, lat, lng, is_visible, location_type)
         VALUES ('tp-place-dup', gen_random_uuid(), 'Дубль места', 'tp-place-dup', 60.1, 165.1, TRUE, 'volcano'),
                ('tp-place-keep', gen_random_uuid(), 'Каноническое место', 'tp-place-keep', 60.1, 165.1, TRUE, 'volcano')`,
      );
      await pool.query(
        `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                     min_participants, max_participants, duration_hours, is_active, is_published,
                                     main_place_id, main_place_source)
         VALUES ($1, 'TP тур дубля', 'tp-dup-tour', 'tp_dup', 5000, 'per_person', 1, 10, 8, TRUE, TRUE, 'tp-place-dup', 'verified')`,
        [TP.id],
      );
      const { carryTourMainPlace } = await import('@/lib/places/merge-carry');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        expect(await carryTourMainPlace(client, 'tp-place-keep', 'tp-place-dup')).toBe(1);
        // merged_into_id — uuid (как в сцене выше, ark_id оставшегося): дубль уходит с витрины.
        await client.query(`UPDATE places SET merged_into_id = (SELECT ark_id FROM places WHERE id = 'tp-place-keep'), merged_at = NOW() WHERE id = 'tp-place-dup'`);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      expect(await linkOf('tp-dup-tour')).toEqual({ main_place_id: 'tp-place-keep', main_place_source: 'verified' });
      const { loadPlaceTours } = await import('@/lib/places/place-tours');
      const keep = await loadPlaceTours('tp-place-keep');
      expect(keep.state === 'ok' && keep.offers.map((o) => o.slug)).toEqual(['tp-dup-tour']);
    });

    // ── 29.10, «1в 2б 3 да»: выбор тура по названию и «ещё N» на карточке ───
    it('резолвер на схеме прода: туры двух компаний — неоднозначно, место у кандидатов, ссылка на туры места', async () => {
      const B = 'b1100000-0000-4000-8000-0000000000b2';
      await pool.query(
        `INSERT INTO partners (id, name, category, contact, slug, is_public, is_verified, status)
         VALUES ($1, 'Тест Вторая Компания', 'operator', '{}'::jsonb, 'test-tp-second', TRUE, FALSE, 'active')`,
        [B],
      );
      const other = (await pool.query<{ id: string }>(
        `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                     min_participants, max_participants, duration_hours, is_active, is_published,
                                     main_place_id, main_place_source)
         VALUES ($1, 'TP многих у второй', 'tp-many-second', 'tp_many', 7000, 'per_group', 1, 10, 8, TRUE, TRUE, 'tp-place-many', 'admin')
         RETURNING id::text`,
        [B],
      )).rows[0].id;

      const { resolveTourChoice } = await import('@/lib/kuzmich/tour-availability-tool');
      const choice = await resolveTourChoice('TP многих');
      expect(choice.kind).toBe('ambiguous');
      if (choice.kind !== 'ambiguous') return;
      // Восемь туров витрины к месту (семь первой компании и один второй); черновика нет.
      expect(choice.candidates).toHaveLength(8);
      expect(choice.candidates.map((c) => c.id)).toContain(Number(other));
      expect(choice.candidates.map((c) => c.slug)).not.toContain('tp-many-draft');
      expect(new Set(choice.candidates.map((c) => c.operator_name))).toEqual(new Set([TP.name, 'Тест Вторая Компания']));
      expect(choice.candidates.every((c) => c.place?.id === 'tp-place-many' && c.place?.slug === 'tp-place-many')).toBe(true);
      // Первый — тур со свободной датой (правило 1в), а не короче название или дешевле.
      expect(choice.candidates[0].nearest_free_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const { tourChoiceTarget } = await import('@/lib/mcp/handoff-targets');
      expect(tourChoiceTarget(choice)).toEqual({ targetType: 'place', targetPath: '/places/tp-place-many#tours' });

      // По номеру — один тур той же компании.
      const one = await resolveTourChoice(other);
      expect(one.kind === 'one' && one.tour.operator_name).toBe('Тест Вторая Компания');

      // «К месту ещё N предложений»: восемь туров к месту, без самого тура — семь.
      const { loadPlaceOffersForTour } = await import('@/lib/places/place-tours');
      const offers = await loadPlaceOffersForTour({ id: other, main_place_id: 'tp-place-many' });
      expect(offers).toEqual({
        state: 'ok', others: 7,
        place: { id: 'tp-place-many', name: 'Место многих туров', slug: 'tp-place-many', ark_id: expect.any(String) },
      });
      // Скрытое место и тур без связи — строки нет.
      expect(await loadPlaceOffersForTour({ id: other, main_place_id: 'tp-place-hidden' })).toEqual({ state: 'none' });
      expect(await loadPlaceOffersForTour({ id: other, main_place_id: null })).toEqual({ state: 'none' });

      // Карточка тура несёт main_place_id — по нему строится строка.
      const { getTourForCard } = await import('@/lib/tours/tour-detail-query');
      expect((await getTourForCard(Number(other)))?.main_place_id).toBe('tp-place-many');
    });
  });
});

