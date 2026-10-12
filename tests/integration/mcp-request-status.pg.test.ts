/**
 * get_request_status на настоящем PostgreSQL (ступень 1 контура, #2371,
 * миграция 1220).
 *
 * Форму SQL доказывает только сервер (§4.0): UPDATE … RETURNING в CTE,
 * LATERAL по броням лида, JOIN на запрос мест — всё исполняется здесь на
 * схеме из baseline прода + всех миграций. Заодно проверяется граница ПД:
 * ответ не содержит ни имени, ни телефона, которые в тестовой базе у лида
 * и запроса мест записаны.
 *
 * Своя база `mcp_request_status_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[mcp-request-status.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'mcp_request_status_test';
/** Первая миграция после baseline (снимок прода 2026-08-15, последняя в нём — 862). */
const FIRST_AFTER_BASELINE = 863;

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

withPg('get_request_status на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  let leadKey = '';
  let seatKey = '';
  let leadId = '';
  let tourId = 0;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await bootstrap.query(`CREATE DATABASE ${TEST_DB}`);
    await bootstrap.end();

    const dbUrl = withDatabase(PG_URL, TEST_DB);
    const env = { ...process.env, DATABASE_URL: dbUrl, DATABASE_SSL: 'false' };
    execFileSync('node', [join(process.cwd(), 'scripts', 'bootstrap-from-baseline.js')], { env, stdio: 'pipe' });
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    await pool.query(
      `DELETE FROM _migrations
        WHERE (regexp_match(name, '^(\\d+)_'))[1]::int >= $1`,
      [FIRST_AFTER_BASELINE],
    );
    execFileSync('npx', ['tsx', join(process.cwd(), 'lib', 'database', 'migrate.ts')], { env, stdio: 'pipe' });

    // Исполнение читает пул приложения — ему нужен тот же адрес.
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    const op = await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, is_verified, is_public, slug)
       VALUES ('Оператор статусов', 'operator', '{"phone":"+70000000000"}', TRUE, TRUE, 'status-op') RETURNING id`,
    );
    const t = await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, is_active, is_published, activity_type, difficulty, duration_hours)
       VALUES ($1, 'Вулкан Горелый', 15000, 10, TRUE, TRUE, 'hiking', 'easy', 8) RETURNING id`, [op.rows[0].id],
    );
    tourId = Number(t.rows[0].id);
    const l = await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, comment, route_title, status, operator_id)
       VALUES ('Иван Тестовый', '+79990001122', '[Заявка на бронь] тест', 'Вулкан Горелый', 'new', $1) RETURNING id`, [op.rows[0].id],
    );
    leadId = l.rows[0].id;
    const r = await pool.query<{ id: string }>(
      `INSERT INTO tour_seat_requests (tour_id, operator_id, tour_date, participants, tourist_name, tourist_phone, reply_channel, status, status_token_hash, deadline_at, source, pd_consent_at)
       VALUES ($1, $2, '2027-07-15', 2, 'Иван Тестовый', '+79990001122', 'phone', 'pending', repeat('a', 64), NOW() + INTERVAL '2 hours', 'mcp', NOW()) RETURNING id`,
      [tourId, op.rows[0].id],
    );
    const { issueRequestKey } = await import('@/lib/mcp/request-status');
    leadKey = (await issueRequestKey({ leadId }, 'create_booking_request')) ?? '';
    seatKey = (await issueRequestKey({ seatRequestId: r.rows[0].id }, 'create_booking_request')) ?? '';
  }, 300_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
  });

  it('ключи выданы и хранятся хешем', async () => {
    expect(leadKey.length).toBeGreaterThanOrEqual(20);
    expect(seatKey.length).toBeGreaterThanOrEqual(20);
    const { rows } = await pool.query<{ key_hash: string; n: string }>(`SELECT key_hash, count(*) OVER () AS n FROM agent_request_keys`);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect([leadKey, seatKey]).not.toContain(row.key_hash);
    }
  });

  it('лид new → ждёт оператора; бронь по лиду → подтверждена; в тексте нет имени и телефона', async () => {
    const { readRequestStatus, runRequestStatusTool } = await import('@/lib/mcp/request-status');
    const v1 = await readRequestStatus(leadKey);
    expect(v1).toMatchObject({ state: 'awaiting_operator', kind: 'lead', tour: 'Вулкан Горелый' });

    await pool.query(
      `INSERT INTO operator_bookings (operator_tour_id, lead_id, booking_date, participants, base_total_price, final_price, booking_status, payment_status, tourist_name, tourist_phone)
       VALUES ($1, $2, '2027-07-15', 2, 30000, 30000, 'confirmed', 'pending', 'Иван Тестовый', '+79990001122')`,
      [tourId, leadId],
    );
    const v2 = await readRequestStatus(leadKey);
    expect(v2).toMatchObject({ state: 'confirmed', kind: 'lead', tour: 'Вулкан Горелый', date: '2027-07-15', participants: 2 });

    const text = await runRequestStatusTool({ key: leadKey });
    expect(text).not.toMatch(/Иван|7999000|@/);
    const { rows: [k] } = await pool.query<{ read_count: number }>(`SELECT read_count FROM agent_request_keys WHERE lead_id = $1`, [leadId]);
    expect(Number(k.read_count)).toBe(3);
  });

  it('запрос мест pending → ждёт с дедлайном; просроченный ключ — «не найден или истёк»', async () => {
    const { readRequestStatus } = await import('@/lib/mcp/request-status');
    const v = await readRequestStatus(seatKey);
    expect(v).toMatchObject({ state: 'awaiting_operator', kind: 'seat_request', tour: 'Вулкан Горелый', date: '2027-07-15', participants: 2 });
    expect(v.deadline).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await pool.query(`UPDATE agent_request_keys SET expires_at = NOW() - INTERVAL '1 minute' WHERE seat_request_id IS NOT NULL`);
    await expect(readRequestStatus(seatKey)).rejects.toThrow(/не найден или истёк/);
  });
});
