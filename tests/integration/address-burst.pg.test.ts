/**
 * Порог адреса и топ хэшей на настоящем PostgreSQL.
 *
 * Мок ответил бы на любой SQL. Здесь проверяется, что запросы приёма,
 * доклада времени и топа вообще выполняются: 31-й просмотр без перехода
 * и без времени метит адрес ботом, доклад времени снимает только эту
 * метку, топ отдаёт 12 знаков хэша. Сырой адрес в строку не попадает.
 *
 * Своя база `address_burst_test`. Без KERNEL_PG_TEST_URL файл пропускается —
 * «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';
import { ipHash } from '@/lib/analytics/visitor-hash';
import { kamchatkaDayBounds } from '@/lib/analytics/kamchatka-day';
import { queryAddressTop } from '@/lib/analytics/address-top';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[address-burst.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'address_burst_test';
const SALT = 'address-burst-pg-salt';
const BURST_IP = '203.0.113.77';
const QUIET_IP = '203.0.113.78';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

withPg('порог адреса на PostgreSQL', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    process.env.CRON_SECRET = SALT;
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    // Иначе FATAL 57P01 на закрывающемся сокете роняет процесс после зелёного теста.
    pool.on('error', () => undefined);
    await pool.query('TRUNCATE page_views');
  });

  afterAll(async () => {
    // Приём и доклад ходят пулом приложения. Не закрыть его до DROP — сеанс
    // остаётся, FORCE обрывает его, клиент без слушателя роняет прогон (57P01).
    const { pool: appPool } = await import('@/lib/db-pool');
    appPool.on('error', () => undefined);
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  });

  it('всплеск без взаимодействия становится ботом, время на странице возвращает людей, топ без сырого адреса', async () => {
    const bounds = kamchatkaDayBounds();
    const at = new Date(bounds.start.getTime() + 60_000).toISOString();
    const burstHash = ipHash(BURST_IP, bounds.day, SALT);
    const quietHash = ipHash(QUIET_IP, bounds.day, SALT);

    for (let i = 0; i < 30; i++) {
      await pool.query(
        `INSERT INTO page_views (path, visitor_hash, created_at, is_bot, is_self, client_beacon, ua_family, ip_hash)
         VALUES ('/kuzmich', $1, $2, FALSE, FALSE, TRUE, 'browser', $3)`,
        [`v${i}`, at, burstHash],
      );
    }
    for (let i = 0; i < 40; i++) {
      await pool.query(
        `INSERT INTO page_views (path, visitor_hash, created_at, is_bot, is_self, from_path, client_beacon, ua_family, ip_hash)
         VALUES ('/catalog', $1, $2, FALSE, FALSE, '/kuzmich', TRUE, 'browser', $3)`,
        [`q${i}`, at, quietHash],
      );
    }

    const { POST } = await import('@/app/api/analytics/hit/route');
    const burstRes = await POST(new NextRequest('http://localhost/api/analytics/hit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': CHROME, 'x-forwarded-for': BURST_IP },
      body: JSON.stringify({ path: '/planning', beacon: true, webdriver: false }),
    }));
    const burst = await burstRes.json() as { audience?: string; id?: string };
    expect(burst.audience).toBe('bot');

    const marked = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM page_views WHERE ip_hash = $1 AND is_bot AND anomaly_bot AND NOT is_self`,
      [burstHash],
    );
    expect(marked.rows[0].n).toBe(31);

    const quiet = await POST(new NextRequest('http://localhost/api/analytics/hit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': CHROME, 'x-forwarded-for': QUIET_IP },
      body: JSON.stringify({ path: '/tours', beacon: true, webdriver: false, fromPath: '/catalog' }),
    }));
    expect((await quiet.json() as { audience?: string }).audience).toBe('person');
    const quietBots = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM page_views WHERE ip_hash = $1 AND (is_bot OR anomaly_bot)`,
      [quietHash],
    );
    expect(quietBots.rows[0].n).toBe(0);

    const leaked = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM page_views
        WHERE path LIKE $1 OR COALESCE(referrer, '') LIKE $1
           OR COALESCE(visitor_hash, '') LIKE $1 OR COALESCE(ua_family, '') LIKE $1
           OR COALESCE(ip_hash, '') LIKE $1 OR COALESCE(from_path, '') LIKE $1`,
      [`%${BURST_IP}%`],
    );
    expect(leaked.rows[0].n).toBe(0);

    const { POST: dwell } = await import('@/app/api/analytics/dwell/route');
    const dwellRes = await dwell(new NextRequest('http://localhost/api/analytics/dwell', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': BURST_IP },
      body: JSON.stringify({ id: burst.id, ms: 1500 }),
    }));
    expect(dwellRes.status).toBe(200);
    const released = await pool.query<{ bots: number; anomaly: number }>(
      `SELECT COUNT(*) FILTER (WHERE is_bot)::int AS bots,
              COUNT(*) FILTER (WHERE anomaly_bot)::int AS anomaly
         FROM page_views WHERE ip_hash = $1`,
      [burstHash],
    );
    expect(released.rows[0].anomaly).toBe(0);
    expect(released.rows[0].bots).toBe(0);

    const top = await queryAddressTop((sql, params) => pool.query(sql, params), bounds);
    expect(top.errorCode).toBeNull();
    expect(top.rows?.[0]).toMatchObject({ hash: quietHash.slice(0, 12), hits: 41, ua: 'browser' });
    expect(top.rows?.[1]).toMatchObject({ hash: burstHash.slice(0, 12), hits: 31, ua: 'browser' });
    expect(JSON.stringify(top)).not.toContain(BURST_IP);
    expect(JSON.stringify(top)).not.toContain(quietHash);
  });
});
