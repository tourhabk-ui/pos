/**
 * Пауза оператора на настоящем PostgreSQL (23.11, слово владельца «Разберись с
 * Местечком»).
 *
 * Пауза 21.11 жила только в блоках туров мест и посадочных, и «Местечко» с
 * шестнадцатью турами стояло в списке компаний, каталоге и ответах агентов.
 * Сцена держит связку на данных, а не на тексте запроса:
 *   - тур компании на паузе (slug из списка паузы сцены) и
 *     приостановленной (`status = 'suspended'`) не проходит шлюз витрины
 *     `publicTourSql`, но открывается по прямой ссылке (`tourOpenByLinkSql`);
 *   - список компаний /operators таких компаний не ставит, живую — ставит;
 *   - вид туров маршрута (`routeMarketplaceSql`: «Туры по маршруту» и цена
 *     маршрута «от») таких туров не отдаёт, а для страницы самой компании
 *     (`byLink`) отдаёт (24.11: вид держит свою копию флагов и паузы не знал).
 *
 * С 25.11 действующий список паузы пуст (пауза «Местечка» снята, слово
 * владельца «Сними паузу»). Механизм остался, и сцена проверяет его на своём
 * списке: модуль паузы подменён так, что умолчание списка — TEST_PAUSED.
 *
 * Запуск: KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл
 * честно пропускается (не прогнан, а не зелёный).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDatabase } from '../helpers/pg-schema';

vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));

const TEST_PAUSED = vi.hoisted(() => ['pause-test-paused'] as const);
vi.mock('@/lib/operators/site-pause', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/operators/site-pause')>();
  return {
    ...orig,
    OPERATOR_SITE_PAUSE_SLUGS: TEST_PAUSED,
    operatorPausedOnTourBlocks: (s: string | null | undefined, p: readonly string[] = TEST_PAUSED) =>
      orig.operatorPausedOnTourBlocks(s, p),
    operatorShownInTourBlocksSql: (a = 'p', p: readonly string[] = TEST_PAUSED) =>
      orig.operatorShownInTourBlocksSql(a, p),
    partnerOffStorefrontIdSql: (c: string, p: readonly string[] = TEST_PAUSED) =>
      orig.partnerOffStorefrontIdSql(c, p),
  };
});

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[operator-pause-gate.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'operator_pause_gate_test';

type Kind = 'live' | 'paused' | 'suspended';
const KINDS: Kind[] = ['live', 'paused', 'suspended'];
const PARTNER: Record<Kind, { id: string; name: string }> = {
  live: { id: 'b1200000-0000-4000-8000-000000000001', name: 'Пауза Тест Живая' },
  paused: { id: 'b1200000-0000-4000-8000-000000000002', name: 'Пауза Тест На паузе' },
  suspended: { id: 'b1200000-0000-4000-8000-000000000003', name: 'Пауза Тест Приостановлена' },
};

withPg('пауза оператора — шлюз витрины и список компаний', () => {
  let pool: import('pg').Pool;
  const tour = {} as Record<Kind, string>;
  const ROUTE_ID = 'b1200000-0000-4000-8000-0000000000aa';
  const slug = {} as Record<Kind, string>;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    // Компания на паузе — та, что названа в списке паузы сцены (TEST_PAUSED).
    slug.live = 'pause-test-live';
    slug.paused = TEST_PAUSED[0];
    slug.suspended = 'pause-test-suspended';

    // Маршрут, к которому привязаны все три тура: вид v_route_marketplace
    // соединяет тур с маршрутом по agent_route_id.
    await pool.query(
      `INSERT INTO _agent_route_knowledge_legacy
         (id, route_dedupe_key, category, title, search_text, source_hash, is_visible, kind)
       VALUES ($1, 'pause-test-route', 'hiking', 'Пауза тест маршрут', 'пауза тест маршрут',
               'pause-test', TRUE, 'route')`,
      [ROUTE_ID],
    );

    for (const k of KINDS) {
      await pool.query(
        `INSERT INTO partners (id, name, category, contact, slug, is_public, is_verified, status)
         VALUES ($1, $2, 'operator', '{}'::jsonb, $3, TRUE, TRUE, $4)`,
        [PARTNER[k].id, PARTNER[k].name, slug[k], k === 'suspended' ? 'suspended' : 'active'],
      );
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                     min_participants, max_participants, duration_hours, difficulty,
                                     is_active, is_published, agent_route_id)
         VALUES ($1, $2, $3, 'jeep_safari', 1000, 'per_person', 1, 10, 8, 'easy', TRUE, TRUE, $4)
         RETURNING id::text`,
        [PARTNER[k].id, `Пауза тест тур ${k}`, `pause-test-tour-${k}`, ROUTE_ID],
      );
      tour[k] = rows[0].id;
    }
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
  });

  const ours = async (where: string): Promise<string[]> => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT ot.id::text AS id FROM operator_tours ot WHERE ot.id::text = ANY($1::text[]) AND ${where}`,
      [KINDS.map((k) => tour[k])],
    );
    return rows.map((r) => r.id).sort();
  };

  it('витрина пускает только тур живой компании', async () => {
    const { publicTourSql } = await import('@/lib/tours/public-visibility');
    expect(await ours(publicTourSql('ot'))).toEqual([tour.live]);
  });

  it('прямая ссылка открывает тур и на паузе, и приостановленной компании', async () => {
    const { tourOpenByLinkSql } = await import('@/lib/tours/public-visibility');
    expect(await ours(tourOpenByLinkSql('ot'))).toEqual(KINDS.map((k) => tour[k]).sort());
  });

  it('список /operators: компании на паузе и приостановленной нет, живая есть', async () => {
    const { queryOperators } = await import('@/lib/operators/list-query');
    const r = await queryOperators({ page: 1, limit: 100, search: 'Пауза Тест' });
    const slugs = r.items.map((i) => i.slug);
    expect(slugs).toContain(slug.live);
    expect(slugs).not.toContain(slug.paused);
    expect(slugs).not.toContain(slug.suspended);
    expect(r.items.find((i) => i.slug === slug.live)?.tourFacts?.total).toBe(1);
  });

  const routeTours = async (byLink: boolean): Promise<string[]> => {
    const { routeMarketplaceSql } = await import('@/lib/routes/marketplace-view');
    const { rows } = await pool.query<{ id: string }>(
      `SELECT v.tour_id::text AS id FROM ${routeMarketplaceSql('v', { byLink })} WHERE v.route_id = $1`,
      [ROUTE_ID],
    );
    return rows.map((r) => r.id).sort();
  };

  it('туры маршрута и его цена: на общей витрине только живая компания', async () => {
    expect(await routeTours(false)).toEqual([tour.live]);
    const { routeTourPriceFromSql } = await import('@/lib/routes/route-tour-price');
    // Цена маршрута — из того же вида: туры компании на паузе её не дают.
    await pool.query(`UPDATE operator_tours SET base_price = 500 WHERE id::text = ANY($1::text[])`, [[tour.paused, tour.suspended]]);
    const { rows } = await pool.query<{ p: string | null }>(
      `SELECT ${routeTourPriceFromSql('ark')} AS p FROM (SELECT $1::uuid AS id, 'route'::text AS kind) ark`,
      [ROUTE_ID],
    );
    expect(Number(rows[0]?.p)).toBe(1000);
  });

  it('страница самой компании по ссылке видит её туры на маршруте', async () => {
    expect(await routeTours(true)).toEqual(KINDS.map((k) => tour[k]).sort());
  });
});
