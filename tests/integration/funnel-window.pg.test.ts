/**
 * Воронка за день — на настоящем PostgreSQL: полуночь, пояс сессии, тип колонки.
 *
 * Статический сторож (tests/unit/funnel-window.test.ts) держит устройство:
 * границы суток параметризованы, «не смог» не превращается в ноль. Но главный
 * вопрос — «попадёт ли просмотр в 23:59:59 во вчера, а в 00:00:00 в сегодня, и
 * не съедет ли это оттого, что сессия базы живёт в МСК, а колонка
 * `operator_bookings.created_at` — `timestamp` БЕЗ пояса» — решается не
 * чтением. Мок ответил бы на любой SQL; форма `$2::timestamptz IS NULL` и
 * `unnest(a, b) WITH ORDINALITY` либо принимается сервером, либо нет.
 *
 * Сцена (сейчас = 17:50 по Камчатке 29.09.2026 = 05:50 UTC):
 *
 *   28.09 23:59:59 KMT   просмотр «a»                    → ВЧЕРА
 *   29.09 00:00:00 KMT   просмотр «b»                    → СЕГОДНЯ
 *   бронь на 23:59:59 / 00:00:00 KMT (колонка без пояса) → вчера / сегодня
 *
 * Прогоняется в двух поясах сессии — МСК (как на проде) и UTC (как в CI):
 * данные пишутся и читаются в одном поясе, и результат обязан совпасть.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  resolveFunnelWindow, buildFunnelReport, funnelByDay,
} from '@/lib/analytics/funnel-window';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

/**
 * Своя база: схема нужна ПОЛНАЯ (page_views, funnel_events, leads,
 * operator_bookings) — baseline прода плюс все миграции, тем же скриптом, что
 * катит деплой. Общая `kernel_test` делится с соседями, и таблицы в ней не мои.
 */
const TEST_DB = 'funnel_window_test';
const FIRST_AFTER_BASELINE = 863;

const NOW = new Date('2026-09-29T05:50:00Z');

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

if (!PG_URL) {
  console.warn(
    '[funnel-window] KERNEL_PG_TEST_URL не задан — тест ПРОПУЩЕН (не прогнан, а не зелёный)',
  );
}

withPg('воронка за окно на настоящем PostgreSQL', () => {
  let dbUrl = '';
  let tourId = 0;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await bootstrap.query(`CREATE DATABASE ${TEST_DB}`);
    await bootstrap.end();

    dbUrl = withDatabase(PG_URL, TEST_DB);
    const env = { ...process.env, DATABASE_URL: dbUrl, DATABASE_SSL: 'false' };
    execFileSync('node', [join(process.cwd(), 'scripts', 'bootstrap-from-baseline.js')], { env, stdio: 'pipe' });
    const admin = new Pool({ connectionString: dbUrl, max: 1 });
    await admin.query(
      `DELETE FROM _migrations
        WHERE (substring(name from '^[0-9]+'))::bigint >= $1
           OR substring(name from '^[0-9]+') IS NULL`,
      [FIRST_AFTER_BASELINE],
    );
    await admin.end();
    execFileSync('npx', ['tsx', join(process.cwd(), 'lib', 'database', 'migrate.ts')], { env, stdio: 'pipe' });

    // Бронь ссылается на тур, тур — на оператора: без них вставка брони не
    // проходит, и сцена осталась бы без броней. Вставка НЕ глушится: молчаливый
    // отказ сида сделал бы проверку броней проверкой пустоты.
    const seed = new Pool({ connectionString: dbUrl, max: 1 });
    const op = await seed.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact) VALUES ('Оператор воронки', 'operator', '{}'::jsonb)
       RETURNING id::text AS id`,
    );
    const tour = await seed.query<{ id: number }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, price_unit, is_active, is_published)
       VALUES ($1, 'Тур для воронки', 10000, 'per_person', true, true) RETURNING id`,
      [op.rows[0]!.id],
    );
    tourId = tour.rows[0]!.id;
    await seed.end();
  }, 240_000);

  afterAll(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
    await bootstrap.end();
  });

  for (const tz of ['Europe/Moscow', 'UTC']) {
    describe(`пояс сессии ${tz}`, () => {
      let pool: Pool;

      beforeAll(async () => {
        pool = new Pool({ connectionString: dbUrl, max: 2, options: `-c TimeZone=${tz}` });
        await pool.query('TRUNCATE page_views, funnel_events, leads, operator_bookings RESTART IDENTITY CASCADE');

        // Просмотры: время — настоящие моменты (timestamptz).
        await pool.query(
          `INSERT INTO page_views (path, created_at, visitor_hash, is_bot, from_path) VALUES
             ('/',                 '2026-09-28T11:59:59Z', 'a', false, NULL),
             ('/',                 '2026-09-28T12:00:00Z', 'b', false, NULL),
             ('/catalog/tours/27', '2026-09-29T04:00:00Z', 'b', false, '/catalog'),
             ('/catalog/tours/27', '2026-09-29T04:05:00Z', 'c', false, '/'),
             ('/',                 '2026-09-29T04:10:00Z', 'x', true,  NULL),
             ('/',                 '2026-09-27T05:00:00Z', 'd', false, NULL),
             ('/catalog/tours/6',  '2026-09-27T06:00:00Z', 'd', false, '/catalog')`,
        );
        await pool.query(
          `INSERT INTO funnel_events (step, visitor_hash, created_at) VALUES
             ('booking_start', 'b', '2026-09-29T04:06:00Z'),
             ('booking_start', 'a', '2026-09-28T11:00:00Z'),
             ('planner_started', 'b', '2026-09-29T04:06:00Z')`,
        );
        await pool.query(
          `INSERT INTO leads (name, phone, status, created_at) VALUES
             ('т1', '+70000000001', 'new',  '2026-09-29T03:00:00Z'),
             ('т2', '+70000000002', 'lost', '2026-09-27T03:00:00Z')`,
        );
        // Колонка БЕЗ пояса: значение пишется по часам сессии, как пишет прод
        // через NOW(). Тот же момент, выраженный в поясе сессии, — так тест не
        // зависит от того, в каком поясе запущен.
        await pool.query(
          `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, created_at, paid_at) VALUES
             ($1, DATE '2026-10-05', 2,
              (TIMESTAMPTZ '2026-09-28T11:59:59Z') AT TIME ZONE current_setting('TimeZone'), NULL),
             ($1, DATE '2026-10-06', 2,
              (TIMESTAMPTZ '2026-09-28T12:00:00Z') AT TIME ZONE current_setting('TimeZone'),
              (TIMESTAMPTZ '2026-09-29T02:00:00Z') AT TIME ZONE current_setting('TimeZone'))`,
          [tourId],
        );
      }, 60_000);

      afterAll(async () => { if (pool) await pool.end(); });

      const report = async (input: Parameters<typeof resolveFunnelWindow>[0]) => {
        const r = resolveFunnelWindow(input, NOW);
        if (!r.ok) throw new Error(r.error);
        return buildFunnelReport(r.window, pool);
      };

      it('запросы выполняются сервером, отказов замеров нет', async () => {
        const r = await report({ range: 'today' });
        expect(r.failed_measures, JSON.stringify(r.failed_measures)).toEqual([]);
        expect(r.meaningful).toBe(true);
      });

      it('сегодня: полночь по Камчатке уже сегодня', async () => {
        const r = await report({ range: 'today' });
        // b (00:00:00) и c; a (23:59:59 вчера) не входит; бот отдельно.
        expect(r.counts.visits).toBe(2);
        expect(r.counts.tour_views).toBe(2);
        expect(r.counts.booking_starts).toBe(1);
        expect(r.counts.leads).toBe(1);
        // Бронь в 00:00:00 по Камчатке (колонка без пояса) — уже сегодня, оплачена.
        expect(r.counts.bookings).toBe(1);
        expect(r.counts.paid).toBe(1);
        expect(r.bot_views).toBe(1);
      });

      it('вчера: 23:59:59 ещё вчера, и верхняя граница не включает полночь', async () => {
        const r = await report({ range: 'yesterday' });
        expect(r.counts.visits).toBe(1);          // только a
        expect(r.counts.tour_views).toBe(0);
        expect(r.counts.booking_starts).toBe(1);  // a в 11:00Z
        expect(r.counts.leads).toBe(0);
        // Бронь в 23:59:59 по Камчатке — ещё вчера, не оплачена.
        expect(r.counts.bookings).toBe(1);
        expect(r.counts.paid).toBe(0);
      });

      it('любая прошлая дата: сутки целиком', async () => {
        const r = await report({ date: '2026-09-27' });
        expect(r.counts.visits).toBe(1);
        expect(r.counts.tour_views).toBe(1);
        expect(r.counts.leads).toBe(1);
      });

      it('7 суток: сумма вчерашнего, сегодняшнего и прошлого', async () => {
        const r = await report({ range: '7d' });
        expect(r.counts.visits).toBe(4);          // a, b, c, d
        expect(r.counts.booking_starts).toBe(2);
        expect(r.counts.leads).toBe(2);
        expect(r.counts.bookings).toBe(2);
        expect(r.counts.paid).toBe(1);
      });

      it('окно суток и соседнее не пересекаются: ничего не посчитано дважды', async () => {
        const today = await report({ range: 'today' });
        const yest = await report({ range: 'yesterday' });
        const d27 = await report({ date: '2026-09-27' });
        const tvSum = (today.counts.tour_views ?? 0) + (yest.counts.tour_views ?? 0) + (d27.counts.tour_views ?? 0);
        const week = await report({ range: '7d' });
        expect(tvSum).toBe(week.counts.tour_views);
      });

      it('разбивка по суткам совпадает с окнами по одному дню', async () => {
        const d = await funnelByDay(NOW, 4, pool);
        expect(d.failed).toEqual([]);
        expect(d.rows.map((x) => x.date)).toEqual(['2026-09-29', '2026-09-28', '2026-09-27', '2026-09-26']);
        expect(d.rows[0].partial).toBe(true);
        expect(d.rows[1].partial).toBe(false);
        for (const row of d.rows) {
          const w = await report({ date: row.date });
          expect({ date: row.date, v: row.visits, t: row.tour_views, s: row.booking_starts, l: row.leads, b: row.bookings, p: row.paid })
            .toEqual({ date: row.date, v: w.counts.visits, t: w.counts.tour_views, s: w.counts.booking_starts, l: w.counts.leads, b: w.counts.bookings, p: w.counts.paid });
        }
      });

      it('день без данных — настоящий ноль, а не «нет данных»', async () => {
        const d = await funnelByDay(NOW, 4, pool);
        const empty = d.rows[3];
        expect(empty.visits).toBe(0);
        expect(empty.leads).toBe(0);
        expect(empty.bookings).toBe(0);
      });

      it('упавший запрос — null и причина, а не ноль', async () => {
        const broken = { query: async () => { throw new Error('relation "leads" does not exist'); } };
        const r = resolveFunnelWindow({ range: 'today' }, NOW);
        if (!r.ok) throw new Error(r.error);
        const rep = await buildFunnelReport(r.window, broken as never);
        expect(rep.counts.visits).toBeNull();
        expect(rep.counts.leads).toBeNull();
        expect(rep.verdict_state).toBe('unknown');
        expect(rep.meaningful).toBe(false);
        const d = await funnelByDay(NOW, 2, broken as never);
        expect(d.rows[0].visits).toBeNull();
        expect(d.failed.length).toBe(4);
      });
    });
  }
});
