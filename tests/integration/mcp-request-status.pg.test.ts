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
 * Заявка на жильё (14.10, миграция 1238): третья цель ключа — строка
 * stay_requests; ограничение «ровно одна цель» на трёх колонках; статус
 * собирается из колонок доставки 1213; согласие человека ложится в саму
 * заявку версией «владельцу жилья»; удалили заявку — ключ ушёл с ней.
 *
 * Своя база `mcp_request_status_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[mcp-request-status.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'mcp_request_status_test';

withPg('get_request_status на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  let leadKey = '';
  let seatKey = '';
  let leadId = '';
  let tourId = 0;
  let stayKey = '';
  let stayRequestId = '';

  beforeAll(async () => {
    const { Pool } = await import('pg');
    // Схема прода — копия шаблона (baseline + миграции новее границы снимка):
    // tests/helpers/pg-schema.ts, аудит 15.10, P2-10.
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });

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

  it('согласие человека пишется поверх записи агента — лид и запрос мест; повтор не трогает; агенту видно полем consent', async () => {
    const { readRequestStatus, confirmConsent, AGENT_CONSENT_SOURCE, HUMAN_CONSENT_SOURCE } = await import('@/lib/mcp/request-status');
    const { buildConsentRecord } = await import('@/lib/legal/pd-consent');
    const record = buildConsentRecord(true, '203.0.113.7', HUMAN_CONSENT_SOURCE);
    if (!record) throw new Error('запись согласия не собралась');

    // Лид в сиде без согласия → none; после подтверждения → human, источник, версия и адрес записаны.
    expect((await readRequestStatus(leadKey)).consent).toBe('none');
    expect(await confirmConsent(leadKey, record)).toBe('recorded');
    const lead = await pool.query<{ pd_consent_source: string; pd_consent_version: string; pd_consent_ip: string }>(
      'SELECT pd_consent_source, pd_consent_version, pd_consent_ip FROM leads WHERE id = $1', [leadId]);
    expect(lead.rows[0]).toMatchObject({ pd_consent_source: HUMAN_CONSENT_SOURCE, pd_consent_version: record.version, pd_consent_ip: '203.0.113.7' });
    expect((await readRequestStatus(leadKey)).consent).toBe('human');
    expect(await confirmConsent(leadKey, record)).toBe('already');

    // Запрос мест с записью агента → agent; подтверждение человека ложится поверх.
    await pool.query(
      `UPDATE tour_seat_requests SET pd_consent_source = $1
        WHERE id = (SELECT seat_request_id FROM agent_request_keys WHERE seat_request_id IS NOT NULL LIMIT 1)`,
      [AGENT_CONSENT_SOURCE],
    );
    expect((await readRequestStatus(seatKey)).consent).toBe('agent');
    expect(await confirmConsent(seatKey, record)).toBe('recorded');
    expect((await readRequestStatus(seatKey)).consent).toBe('human');

    // Чужой ключ — отказ по входу, не «записано».
    await expect(confirmConsent('AbCdEfGhIjKlMnOpQrStUvWxYz012345', record)).rejects.toThrow(/не найден или истёк/);
  });

  it('запрос мест pending → ждёт с дедлайном; просроченный ключ — «не найден или истёк»', async () => {
    const { readRequestStatus } = await import('@/lib/mcp/request-status');
    const v = await readRequestStatus(seatKey);
    expect(v).toMatchObject({ state: 'awaiting_operator', kind: 'seat_request', tour: 'Вулкан Горелый', date: '2027-07-15', participants: 2 });
    expect(v.deadline).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await pool.query(`UPDATE agent_request_keys SET expires_at = NOW() - INTERVAL '1 minute' WHERE seat_request_id IS NOT NULL`);
    await expect(readRequestStatus(seatKey)).rejects.toThrow(/не найден или истёк/);
  });

  it('заявка на жильё: ключ на строку stay_requests, статус «передана владельцу», без имени и телефона', async () => {
    const { issueRequestKey, readRequestStatus, runRequestStatusTool } = await import('@/lib/mcp/request-status');
    const { PD_CONSENT_STAY_VERSION } = await import('@/lib/legal/pd-consent');
    const acc = await pool.query<{ id: string }>(
      `INSERT INTO accommodations (name, type, coordinates, contact_phone)
       VALUES ('Кутха', 'guesthouse', '{"lat":53.0,"lng":158.6}', '+70000000001') RETURNING id`,
    );
    const sr = await pool.query<{ id: string }>(
      `INSERT INTO stay_requests (accommodation_id, check_in_date, check_out_date, guests, guest_name, guest_phone, comment,
                                  pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version, door)
       VALUES ($1, '2027-07-10', '2027-07-12', 9, 'Иван Тестовый', '+79990001122', 'Баня вечером',
               NOW(), '203.0.113.9', 'mcp', $2, 'mcp') RETURNING id`,
      [acc.rows[0].id, PD_CONSENT_STAY_VERSION],
    );
    stayRequestId = sr.rows[0].id;
    await pool.query(
      `UPDATE stay_requests SET owner_channel = 'max', owner_reason = 'доставлено в MAX',
              platform_channel = 'max', platform_reason = 'доставлено в MAX', delivery_recorded_at = NOW()
        WHERE id = $1`, [stayRequestId],
    );
    stayKey = (await issueRequestKey({ stayRequestId }, 'create_stay_request')) ?? '';
    expect(stayKey.length).toBeGreaterThanOrEqual(20);

    const v = await readRequestStatus(stayKey);
    expect(v).toMatchObject({
      state: 'delivered', kind: 'stay_request', tour: null, accommodation: 'Кутха',
      date: '2027-07-10', check_out: '2027-07-12', participants: 9,
      consent: 'agent', consent_purpose: 'stay',
    });
    expect(v.accommodation_url).toMatch(new RegExp(`/accommodations/${acc.rows[0].id}$`));
    const text = await runRequestStatusTool({ key: stayKey });
    expect(text).not.toMatch(/Иван|7999000|Баня|203\.0\.113/);
  });

  it('ключ смотрит ровно в одну заявку: две цели сразу база не примет', async () => {
    await expect(pool.query(
      `INSERT INTO agent_request_keys (key_hash, lead_id, stay_request_id, tool_name, expires_at)
       VALUES (repeat('b', 64), $1, $2, 'create_stay_request', NOW() + INTERVAL '1 day')`,
      [leadId, stayRequestId],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('согласие человека по заявке на жильё ложится в саму заявку версией «владельцу жилья»', async () => {
    const { readRequestStatus, readConsentPurpose, confirmConsent, HUMAN_CONSENT_SOURCE } = await import('@/lib/mcp/request-status');
    const { buildConsentRecord, PD_CONSENT_STAY_VERSION } = await import('@/lib/legal/pd-consent');
    const purpose = await readConsentPurpose(stayKey);
    expect(purpose).toBe('stay');
    const record = buildConsentRecord(true, '203.0.113.10', HUMAN_CONSENT_SOURCE, purpose);
    if (!record) throw new Error('запись согласия не собралась');

    expect(await confirmConsent(stayKey, record)).toBe('recorded');
    const { rows: [row] } = await pool.query<{ pd_consent_source: string; pd_consent_version: string; pd_consent_ip: string }>(
      'SELECT pd_consent_source, pd_consent_version, pd_consent_ip FROM stay_requests WHERE id = $1', [stayRequestId]);
    expect(row).toEqual({ pd_consent_source: HUMAN_CONSENT_SOURCE, pd_consent_version: PD_CONSENT_STAY_VERSION, pd_consent_ip: '203.0.113.10' });
    expect((await readRequestStatus(stayKey)).consent).toBe('human');
    expect(await confirmConsent(stayKey, record)).toBe('already');
  });

  it('удалили заявку на жильё — ключ ушёл с ней', async () => {
    const { readRequestStatus } = await import('@/lib/mcp/request-status');
    await pool.query('DELETE FROM stay_requests WHERE id = $1', [stayRequestId]);
    const { rows } = await pool.query('SELECT 1 FROM agent_request_keys WHERE stay_request_id = $1', [stayRequestId]);
    expect(rows).toHaveLength(0);
    await expect(readRequestStatus(stayKey)).rejects.toThrow(/не найден или истёк/);
  });
});
