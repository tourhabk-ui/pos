/**
 * Тестовый профиль партнёра не на витрине — на настоящем PostgreSQL
 * (миграция 1495, #2770 часть 2, слово владельца 22.11 «да»).
 *
 * Мок ответил бы на любой SQL, поэтому здесь судится сама база и настоящие
 * читатели витрины:
 *  - CHECK partners_test_not_public: тестовый профиль на витрину не встаёт;
 *  - дверь отметки снимает карточку с витрины, снятие отметки её не
 *    возвращает; одобрение администратора тестовый профиль на витрину не ставит;
 *  - тур тестового партнёра не видят рекомендации, фид площадок, инструменты
 *    Кузьмича (поиск, подробности, даты), а список компаний /operators и
 *    общий список заявок без адресата не видят саму карточку;
 *  - недельная сводка называет такой тур своей причиной, сумма вёдер — все
 *    невидимые;
 *  - миграция ставит отметку карточке FLO по почте и повторный прогон её не
 *    ломает.
 *
 * Своя база `partner_test_profile_test`. Без KERNEL_PG_TEST_URL файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock('@/lib/auth/middleware', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/middleware')>()),
  requireAdmin: vi.fn(async () => ({ userId: 'b2200000-0000-4000-8000-0000000000ad', role: 'admin' })), // = ADMIN_ID
}));
vi.mock('@/lib/notifications/email-service', () => ({ emailService: { sendEmail: vi.fn(async () => undefined) } }));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[partner-test-profile.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'partner_test_profile_test';
const ADMIN_ID = 'b2200000-0000-4000-8000-0000000000ad';
const LIVE = { id: 'b2200000-0000-4000-8000-000000000001', slug: 'tp-live-operator', name: 'ТП Живая компания', activity: 'tp_live' };
const TEST = { id: 'b2200000-0000-4000-8000-000000000002', slug: 'tp-test-operator', name: 'ТП Тестовая компания', activity: 'tp_test' };

withPg('тестовый профиль партнёра — не на витрине (1495)', () => {
  let pool: import('pg').Pool;
  let dbUrl = '';
  const tourId = {} as Record<'live' | 'test', string>;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    // Одобрение пишет verified_by — администратор должен быть в users.
    await pool.query(
      `INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, 'tp-admin@example.test', 'Администратор', 'x', 'admin')`,
      [ADMIN_ID],
    );
    for (const p of [LIVE, TEST]) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, 'x', 'operator') RETURNING id::text`,
        [`${p.slug}@example.test`, p.name],
      );
      await pool.query(
        `INSERT INTO partners (id, user_id, name, category, contact, slug, is_public, is_verified, status, profile_status)
         VALUES ($1, $2, $3, 'operator', '{}'::jsonb, $4, TRUE, TRUE, 'active', 'approved')`,
        [p.id, rows[0].id, p.name, p.slug],
      );
      const tour = await pool.query<{ id: string }>(
        `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                     min_participants, max_participants, duration_hours, difficulty,
                                     is_active, is_published, review_count)
         VALUES ($1, $2, $3, $4, 1000, 'per_person', 1, 10, 8, 'easy', TRUE, TRUE, 1000000)
         RETURNING id::text`,
        [p.id, `${p.name} тур`, `${p.slug}-tour`, p.activity],
      );
      tourId[p === LIVE ? 'live' : 'test'] = tour.rows[0].id;
    }
    await import('@/lib/kuzmich/core');
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
    if (dbUrl) await dropTestDatabase(PG_URL, TEST_DB);
  });

  it('база не держит тестовый профиль на витрине', async () => {
    await expect(pool.query(`UPDATE partners SET is_test = TRUE WHERE id = $1`, [TEST.id]))
      .rejects.toMatchObject({ code: '23514', constraint: 'partners_test_not_public' });
  });

  it('дверь отметки: карточка уходит с витрины тем же запросом', async () => {
    const { PATCH } = await import('@/app/api/admin/operators/[id]/test-profile/route');
    const res = await PATCH(
      new NextRequest(`http://localhost/api/admin/operators/${TEST.id}/test-profile`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ is_test: true }),
      }),
      { params: Promise.resolve({ id: TEST.id }) },
    );
    expect(res.status).toBe(200);
    const { rows } = await pool.query<{ is_test: boolean; is_public: boolean }>(
      `SELECT is_test, is_public FROM partners WHERE id = $1`, [TEST.id],
    );
    expect(rows[0]).toEqual({ is_test: true, is_public: false });
    // Поставить на витрину правкой карточки — отказ базы.
    await expect(pool.query(`UPDATE partners SET is_public = TRUE WHERE id = $1`, [TEST.id]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('одобрение администратора тестовый профиль на витрину не ставит', async () => {
    const { PATCH } = await import('@/app/api/admin/operators/[id]/route');
    const res = await PATCH(
      new NextRequest(`http://localhost/api/admin/operators/${TEST.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve' }),
      }),
      { params: Promise.resolve({ id: TEST.id }) },
    );
    expect(res.status).toBeLessThan(300);
    const { rows } = await pool.query<{ is_public: boolean }>(`SELECT is_public FROM partners WHERE id = $1`, [TEST.id]);
    expect(rows[0].is_public).toBe(false);
  });

  it('тур тестового партнёра не видят рекомендации, фид и инструменты Кузьмича', async () => {
    const { getRecommendations } = await import('@/lib/search/tour-recommend');
    const user = 'b2200000-0000-4000-8000-0000000000aa';
    expect((await getRecommendations(user, 6, TEST.activity)).map((r) => String(r.id))).toEqual([]);
    expect((await getRecommendations(user, 6, LIVE.activity)).map((r) => String(r.id))).toEqual([tourId.live]);

    const { GET } = await import('@/app/api/tours-feed/route');
    const feed = async (slug: string) => {
      const res = await GET(new NextRequest(`http://localhost/api/tours-feed?operator=${slug}`));
      return ((await res.json()) as { tours: { id: string | number }[] }).tours.map((t) => String(t.id));
    };
    expect(await feed(TEST.slug)).toEqual([]);
    expect(await feed(LIVE.slug)).toEqual([tourId.live]);

    const { getTouristTools } = await import('@/lib/agents/sdk/tourist-tools');
    const tools = getTouristTools(null);
    const run = async (name: string, args: Record<string, unknown>) => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`инструмента ${name} нет`);
      return JSON.parse(await t.execute(args)) as Record<string, unknown>;
    };
    expect((await run('search_tours', { activity_type: TEST.activity })).found).toBe(0);
    expect((await run('search_tours', { activity_type: LIVE.activity })).found).toBe(1);
    expect((await run('get_tour_details', { tour_id: tourId.test })).error).toBe('Тур не найден или снят с публикации');
    expect((await run('check_availability', { tour_id: tourId.test })).available).toBe(false);
  });

  it('карточку не видят список компаний и общий список заявок без адресата', async () => {
    const { queryOperators } = await import('@/lib/operators/list-query');
    const slugs = (await queryOperators({ page: 1, limit: 50 })).items.map((i) => i.slug);
    expect(slugs).toContain(LIVE.slug);
    expect(slugs).not.toContain(TEST.slug);

    const { partnerAdmitted } = await import('@/lib/leads/ownership');
    expect(await partnerAdmitted(TEST.id)).toBe(false);
    expect(await partnerAdmitted(LIVE.id)).toBe(true);
  });

  it('недельная сводка: тур тестового партнёра — своя причина, сумма вёдер — все невидимые', async () => {
    const { PLATFORM_WEEK_SQL } = await import('@/lib/agents/platform-week-stats');
    const { rows } = await pool.query<{
      tours_hidden: number; hidden_draft: number; hidden_inactive: number; hidden_both: number; hidden_test_profile: number;
    }>(PLATFORM_WEEK_SQL);
    const s = rows[0]!;
    expect(s.hidden_test_profile).toBeGreaterThanOrEqual(1);
    expect(s.hidden_draft + s.hidden_inactive + s.hidden_both + s.hidden_test_profile).toBe(s.tours_hidden);
  });

  it('снятие отметки витрину не возвращает, а тур снова виден шлюзу', async () => {
    const { PATCH } = await import('@/app/api/admin/operators/[id]/test-profile/route');
    const res = await PATCH(
      new NextRequest(`http://localhost/api/admin/operators/${TEST.id}/test-profile`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ is_test: false }),
      }),
      { params: Promise.resolve({ id: TEST.id }) },
    );
    expect(res.status).toBe(200);
    const { rows } = await pool.query<{ is_test: boolean; is_public: boolean }>(
      `SELECT is_test, is_public FROM partners WHERE id = $1`, [TEST.id],
    );
    expect(rows[0]).toEqual({ is_test: false, is_public: false });
    const { getRecommendations } = await import('@/lib/search/tour-recommend');
    expect((await getRecommendations('b2200000-0000-4000-8000-0000000000aa', 6, TEST.activity)).map((r) => String(r.id)))
      .toEqual([tourId.test]);
  });

  it('миграция 1495 ставит отметку карточке FLO по почте; повторный прогон не ломается', async () => {
    const flo = 'b2200000-0000-4000-8000-000000000003';
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ('Flo@Vedarai.ru', 'Тестовый оператор', 'x', 'operator') RETURNING id::text`,
    );
    await pool.query(
      `INSERT INTO partners (id, user_id, name, category, contact, slug, is_public, status)
       VALUES ($1, $2, 'Тестовый оператор FLO', 'operator', '{}'::jsonb, 'tp-flo', TRUE, 'active')`,
      [flo, rows[0].id],
    );
    const sql = readFileSync(join(process.cwd(), 'migrations/1495_partner_test_profile.sql'), 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const after = await pool.query<{ id: string; is_test: boolean; is_public: boolean }>(
      `SELECT id::text, is_test, is_public FROM partners WHERE id = ANY($1::uuid[]) ORDER BY id`, [[LIVE.id, flo]],
    );
    expect(after.rows).toEqual([
      { id: LIVE.id, is_test: false, is_public: true },
      { id: flo, is_test: true, is_public: false },
    ]);
  });
});

