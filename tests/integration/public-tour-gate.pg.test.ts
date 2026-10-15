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
 * Своя база `public_tour_gate_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from '../helpers/pg-schema';

vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));

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
});
