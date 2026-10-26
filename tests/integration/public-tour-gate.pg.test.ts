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
      // Источник — только из двух названных.
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
  });
});
