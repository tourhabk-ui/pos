/**
 * Счёт просмотров с записанным временем на настоящем PostgreSQL (21.11).
 *
 * Фрагмент PAGE_DWELL_COLUMNS подставляется в оба запроса поведения
 * витрины трафика (app/api/admin/analytics/traffic/route.ts). Здесь он
 * выполняется на той же форме: окно LEAD по визиту, уход — последний
 * просмотр визита. Своя база `page_dwell_test`. Без KERNEL_PG_TEST_URL файл
 * пропускается — не прогнан, а не зелёный.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';
import { PAGE_DWELL_COLUMNS, pageDwellCounts, dwellExitShare } from '@/lib/analytics/page-dwell';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[page-dwell.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'page_dwell_test';

withPg('просмотры с записанным временем на PostgreSQL', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    pool.on('error', () => undefined);
    await pool.query('TRUNCATE page_views');
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  });

  it('со временем и уход среди них — тем же правилом ухода, что общий счёт', async () => {
    const rows: Array<[string, string | null, number | null, number]> = [
      // Визит a: /planning со временем → /planner (не уход), /planner без времени — уход.
      ['/planning', 'a', 4000, 0],
      ['/planner', 'a', null, 60],
      // Визит b: /planning со временем — уход.
      ['/planning', 'b', 3000, 0],
      // Визиты c, d: /planning без времени — уходы (автоматический браузер).
      ['/planning', 'c', null, 0],
      ['/planning', 'd', null, 0],
      // Без визита: время есть, но уходом не считается — как в общем счёте.
      ['/planning', null, 2000, 0],
    ];
    for (const [path, session, dwell, offsetSec] of rows) {
      await pool.query(
        `INSERT INTO page_views (path, visitor_hash, session_id, dwell_ms, created_at, is_bot, is_self)
         VALUES ($1, 'v', $2, $3, NOW() - INTERVAL '1 hour' + make_interval(secs => $4::int), FALSE, FALSE)`,
        [path, session, dwell, offsetSec],
      );
    }

    const res = await pool.query<{ path: string; views: string; exits: string; with_dwell: string; with_dwell_exits: string }>(`
      WITH v AS (
        SELECT id, path, session_id, dwell_ms, created_at,
               LEAD(id) OVER (PARTITION BY session_id ORDER BY created_at) AS next_id
          FROM page_views
         WHERE created_at >= NOW() - INTERVAL '30 days' AND is_bot = FALSE AND is_self = FALSE
      )
      SELECT path,
             COUNT(*) AS views,
             COUNT(*) FILTER (WHERE session_id IS NOT NULL AND next_id IS NULL) AS exits,
             ${PAGE_DWELL_COLUMNS}
        FROM v
       GROUP BY path
       ORDER BY path`);

    const byPath = Object.fromEntries(res.rows.map(r => [r.path, r]));
    const planning = byPath['/planning'];
    expect(Number(planning.views)).toBe(5);
    expect(Number(planning.exits)).toBe(3);
    const counts = pageDwellCounts(planning);
    expect(counts).toEqual({ withDwell: 3, withDwellExits: 1 });
    expect(dwellExitShare(counts)).toBe(33);

    const planner = pageDwellCounts(byPath['/planner']);
    expect(planner).toEqual({ withDwell: 0, withDwellExits: 0 });
    expect(dwellExitShare(planner)).toBeNull();
  });
});
