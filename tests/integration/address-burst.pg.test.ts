/**
 * Порог адреса и топ хэшей на настоящем PostgreSQL.
 *
 * Мок ответил бы на любой SQL. Здесь проверяется, что запросы приёма,
 * доклада времени и топа вообще выполняются: 31-й просмотр без перехода
 * и без времени метит адрес ботом, доклад времени снимает только эту
 * метку, топ отдаёт 12 знаков хэша. Сырой адрес в строку не попадает.
 *
 * Качество 24.10: короткое время на странице трекер шлёт сам при уходе,
 * и бот, исполняющий JS, оставляет его на каждой строке — оно не снимает
 * порог. Взаимодействие снимает метку только своего визита, а бот по
 * признаку браузера и свой заход остаются как были при всплеске, докладе
 * времени и переходе.
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
import { ENGAGED_DWELL_MS } from '@/lib/analytics/address-burst';

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
        `INSERT INTO page_views (path, visitor_hash, created_at, is_bot, is_self, client_beacon, ua_family, ip_hash, session_id)
         VALUES ('/kuzmich', $1, $2, FALSE, FALSE, TRUE, 'browser', $3, 'burst-visit')`,
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
      body: JSON.stringify({ path: '/planning', beacon: true, webdriver: false, sessionId: 'burst-visit' }),
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
      body: JSON.stringify({ id: burst.id, ms: ENGAGED_DWELL_MS + 1000 }),
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
  /** Камчатские сутки, строки текущего дня и хэш адреса для одного сценария. */
  async function freshDay(ip: string) {
    await pool.query('TRUNCATE page_views');
    const bounds = kamchatkaDayBounds();
    return { at: new Date(bounds.start.getTime() + 60_000).toISOString(), hash: ipHash(ip, bounds.day, SALT) };
  }

  async function insertView(v: {
    at: string; hash: string; session: string | null; dwell?: number | null; fromPath?: string | null;
    isBot?: boolean; isSelf?: boolean; family?: string; beacon?: boolean; path?: string;
  }): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO page_views (path, visitor_hash, created_at, is_bot, is_self, client_beacon, ua_family, ip_hash, session_id, dwell_ms, from_path)
       VALUES ($1, 'vh', $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [v.path ?? '/kuzmich', v.at, v.isBot ?? false, v.isSelf ?? false, v.beacon ?? true, v.family ?? 'browser',
        v.hash, v.session, v.dwell ?? null, v.fromPath ?? null],
    );
    return String(res.rows[0].id);
  }

  async function hit(ip: string, body: Record<string, unknown>): Promise<{ audience?: string; id?: string }> {
    const { POST } = await import('@/app/api/analytics/hit/route');
    const res = await POST(new NextRequest('http://localhost/api/analytics/hit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': CHROME, 'x-forwarded-for': ip },
      body: JSON.stringify({ beacon: true, webdriver: false, ...body }),
    }));
    return await res.json() as { audience?: string; id?: string };
  }

  async function dwellReport(ip: string, id: string | undefined, ms: number): Promise<number> {
    const { POST } = await import('@/app/api/analytics/dwell/route');
    const res = await POST(new NextRequest('http://localhost/api/analytics/dwell', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ id, ms }),
    }));
    return res.status;
  }

  async function anomalyCount(hash: string, session: string | null): Promise<number> {
    const res = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM page_views
        WHERE ip_hash = $1 AND session_id IS NOT DISTINCT FROM $2 AND is_bot AND anomaly_bot`,
      [hash, session],
    );
    return res.rows[0].n;
  }

  async function rowState(id: string) {
    const res = await pool.query<{ is_bot: boolean; anomaly_bot: boolean; is_self: boolean }>(
      'SELECT is_bot, anomaly_bot, is_self FROM page_views WHERE id = $1',
      [id],
    );
    return res.rows[0];
  }

  it('бот, исполняющий JS: время, которое трекер шлёт при уходе, порог не снимает', async () => {
    const ip = '203.0.113.81';
    const { at, hash } = await freshDay(ip);
    // page.goto по 30 страницам: при каждом уходе браузер сам досылает доли секунды.
    for (let i = 0; i < 30; i++) {
      await insertView({ at, hash, session: 'js-bot-visit', dwell: 50 });
    }
    // Человек за тем же адресом уже читал страницу: себя он делает человеком,
    // но бота в соседнем визите не прикрывает.
    const reader = await insertView({ at, hash, session: 'reader-visit', dwell: ENGAGED_DWELL_MS * 2, path: '/catalog' });

    const first = await hit(ip, { path: '/tours', sessionId: 'js-bot-visit' });
    expect(first.audience).toBe('bot');
    expect(await anomalyCount(hash, 'js-bot-visit')).toBe(31);
    expect(await rowState(reader)).toEqual({ is_bot: false, anomaly_bot: false, is_self: false });

    const second = await hit(ip, { path: '/places', sessionId: 'js-bot-visit' });
    expect(second.audience).toBe('bot');

    // Чужой доклад «0 мс» по последовательному id метку не снимает, и повтор
    // с длинным временем поверх уже записанного короткого — тоже.
    expect(await dwellReport('198.51.100.9', first.id, 0)).toBe(200);
    expect(await dwellReport('198.51.100.9', first.id, ENGAGED_DWELL_MS * 3)).toBe(200);
    // Уход бота с последней страницы — короткое время, тоже не взаимодействие.
    expect(await dwellReport(ip, second.id, ENGAGED_DWELL_MS - 1)).toBe(200);
    expect(await anomalyCount(hash, 'js-bot-visit')).toBe(32);

    const third = await hit(ip, { path: '/map', sessionId: 'js-bot-visit' });
    expect(third.audience).toBe('bot');
    expect(await anomalyCount(hash, 'js-bot-visit')).toBe(33);
    expect(await rowState(reader)).toEqual({ is_bot: false, anomaly_bot: false, is_self: false });
  });

  it('взаимодействие снимает метку только своего визита; бот по признаку браузера и свой заход остаются как были', async () => {
    const ip = '203.0.113.82';
    const { at, hash } = await freshDay(ip);
    for (let i = 0; i < 30; i++) {
      await insertView({ at, hash, session: 'bot-visit' });
    }
    // Тот же адрес: человек в своём визите ещё ни разу не задержался,
    // рядом с ним — строка автобраузера (webdriver) и свой заход, а без
    // визита — ИИ-краулер. Порог не должен касаться трёх последних никак.
    const person = await insertView({ at, hash, session: 'person-visit', path: '/catalog' });
    const webdriver = await insertView({ at, hash, session: 'person-visit', isBot: true, path: '/catalog/tours/1' });
    const own = await insertView({ at, hash, session: 'person-visit', isSelf: true, path: '/catalog' });
    const crawler = await insertView({ at, hash, session: null, isBot: true, family: 'openai', beacon: false, path: '/' });

    const burst = await hit(ip, { path: '/planning', sessionId: 'bot-visit' });
    expect(burst.audience).toBe('bot');
    expect(await anomalyCount(hash, 'bot-visit')).toBe(31);
    expect(await rowState(person)).toEqual({ is_bot: true, anomaly_bot: true, is_self: false });
    expect(await rowState(webdriver)).toEqual({ is_bot: true, anomaly_bot: false, is_self: false });
    expect(await rowState(own)).toEqual({ is_bot: false, anomaly_bot: false, is_self: true });
    expect(await rowState(crawler)).toEqual({ is_bot: true, anomaly_bot: false, is_self: false });

    // Человек прочитал страницу: его визит — люди, визит бота — по-прежнему бот.
    expect(await dwellReport(ip, person, ENGAGED_DWELL_MS + 2000)).toBe(200);
    expect(await rowState(person)).toEqual({ is_bot: false, anomaly_bot: false, is_self: false });
    expect(await anomalyCount(hash, 'bot-visit')).toBe(31);
    expect(await rowState(webdriver)).toEqual({ is_bot: true, anomaly_bot: false, is_self: false });
    expect(await rowState(own)).toEqual({ is_bot: false, anomaly_bot: false, is_self: true });
    expect(await rowState(crawler)).toEqual({ is_bot: true, anomaly_bot: false, is_self: false });

    // Переход в визите человека: снова только свой визит.
    const moved = await hit(ip, { path: '/tours', sessionId: 'person-visit', fromPath: '/catalog' });
    expect(moved.audience).toBe('person');
    expect(await anomalyCount(hash, 'bot-visit')).toBe(31);
    expect(await rowState(webdriver)).toEqual({ is_bot: true, anomaly_bot: false, is_self: false });
    expect(await rowState(own)).toEqual({ is_bot: false, anomaly_bot: false, is_self: true });
    expect(await rowState(crawler)).toEqual({ is_bot: true, anomaly_bot: false, is_self: false });

    // Взаимодействие соседа не делает людьми следующий просмотр бота.
    const next = await hit(ip, { path: '/map', sessionId: 'bot-visit' });
    expect(next.audience).toBe('bot');
    expect(await anomalyCount(hash, 'bot-visit')).toBe(32);
    expect(await anomalyCount(hash, 'person-visit')).toBe(0);
  });

  it('просмотр без визита — визит из одной строки: своё взаимодействие спасает только его, чужое без визита не прикрывает', async () => {
    const ip = '203.0.113.83';
    const { at, hash } = await freshDay(ip);
    for (let i = 0; i < 30; i++) {
      await insertView({ at, hash, session: 'bot-visit' });
    }
    // Хранилище закрыто (приватный режим) — sessionId нет. Один уже читал
    // страницу, другой перешёл дальше, третий ушёл через доли секунды.
    const readerNoVisit = await insertView({ at, hash, session: null, dwell: ENGAGED_DWELL_MS * 2, path: '/catalog' });
    const movedNoVisit = await insertView({ at, hash, session: null, fromPath: '/catalog', path: '/tours' });
    const quickNoVisit = await insertView({ at, hash, session: null, dwell: 50, path: '/map' });

    // Новый просмотр без визита: чужие строки без визита его визитом не считаются.
    const fresh = await hit(ip, { path: '/planning' });
    expect(fresh.audience).toBe('bot');
    expect(await anomalyCount(hash, 'bot-visit')).toBe(30);
    // Строка, у которой своё взаимодействие есть, всплеском не метится.
    expect(await rowState(readerNoVisit)).toEqual({ is_bot: false, anomaly_bot: false, is_self: false });
    expect(await rowState(movedNoVisit)).toEqual({ is_bot: false, anomaly_bot: false, is_self: false });
    expect(await rowState(quickNoVisit)).toEqual({ is_bot: true, anomaly_bot: true, is_self: false });
    expect(await anomalyCount(hash, null)).toBe(2);

    // Своё время на странице снимает метку самой строки — и только её.
    expect(await dwellReport(ip, fresh.id, ENGAGED_DWELL_MS + 1000)).toBe(200);
    expect(await rowState(String(fresh.id))).toEqual({ is_bot: false, anomaly_bot: false, is_self: false });
    expect(await rowState(quickNoVisit)).toEqual({ is_bot: true, anomaly_bot: true, is_self: false });
    expect(await anomalyCount(hash, 'bot-visit')).toBe(30);

    // Переход без визита: сама строка человек, чужие метки остаются.
    const moved = await hit(ip, { path: '/tours', fromPath: '/planning' });
    expect(moved.audience).toBe('person');
    expect(await rowState(quickNoVisit)).toEqual({ is_bot: true, anomaly_bot: true, is_self: false });
    expect(await anomalyCount(hash, 'bot-visit')).toBe(30);
  });
});
