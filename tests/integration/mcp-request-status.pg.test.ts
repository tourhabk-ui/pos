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
 * Одна правда (29.10): запрос мест смотрит на свою бронь — перенос и отмена
 * подтверждённой брони НАСТОЯЩИМИ rescheduleBooking/cancelBooking доходят до
 * ключа; лид после разбора ИИ-конвейером — «ждёт оператора»; обёртка по
 * номерам ключей (для сверки уведомлений) читает то же и не отмечает
 * прочтение.
 *
 * Подписка на уведомления (1348): миграция повторяется без ошибки; подписка
 * пишется ВТОРЫМ запросом к уже выданному ключу (ключ от неё не зависит),
 * адрес и ключ подписи — шифртекстом, привязанным к ref; база отсчёта —
 * тем же читателем; CHECK держат словарь причин, форму ref и «живая — с
 * адресом»; удалили заявку — ушли ключ и подписка.
 *
 * Сцена уведомлений (29.10): подписка заводится вместе с заявкой; сверка на
 * настоящем SQL — без изменений ноль POST, «другая дата», перенос и отмена
 * подтверждённой брони (настоящими rescheduleBooking/cancelBooking) — ровно
 * по одному уведомлению с верной подписью и без ПД; отказ приёмника —
 * повтор через 30 минут, предел — отключение с причиной; 410 — сразу;
 * захват построчный; отключённая строка удаляется через 30 дней.
 *
 * ОТПРАВИТЕЛЬ В СЦЕНЕ ПОДЛОЖЕН, и это не обход проверки, а её следствие:
 * защита адреса пропускает только https на порт 443 по имени, которое
 * разрешается в ПУБЛИЧНЫЕ адреса, — локальный приёмник на 127.0.0.1 она
 * обязана отвергнуть. Поэтому здесь runRequestNotify получает `send` явной
 * зависимостью, а сама защита (форма адреса, публичность IP, разрешение
 * имени, абсолютный срок, отказ от редиректов) проверяется отдельно юнитами:
 * tests/unit/public-address.test.ts.
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

  it('согласие человека с формы сайта ключ не перезаписывает — и ключ повтора тоже (1350)', async () => {
    const { confirmConsent, issueRequestKey, HUMAN_CONSENT_SOURCE, CHARTER_FORM_KEY_NAME } = await import('@/lib/mcp/request-status');
    const { buildConsentRecord } = await import('@/lib/legal/pd-consent');
    const op = await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact) VALUES ('Перевозчик согласия', 'transfer', '{}') RETURNING id`,
    );
    const formAt = new Date('2026-10-29T10:00:00Z');
    const l = await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, comment, status, operator_id, pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version)
       VALUES ('Анна', '+79990002233', '[Заявка на машину] тест', 'new', $1, $2, '198.51.100.1', 'transfer-page', '2026-10-13-carrier')
       RETURNING id`,
      [op.rows[0].id, formAt],
    );
    // Ключ, выданный на повтор той же заявки (форма отдала прежний лид).
    const repeatKey = await issueRequestKey({ leadId: l.rows[0].id }, CHARTER_FORM_KEY_NAME, { opensChat: false });
    const record = buildConsentRecord(true, '203.0.113.66', HUMAN_CONSENT_SOURCE, 'carrier');
    if (!repeatKey || !record) throw new Error('ключ или запись согласия не собрались');
    expect(await confirmConsent(repeatKey, record)).toBe('already');
    const after = await pool.query<{ pd_consent_source: string; pd_consent_ip: string; at: Date }>(
      'SELECT pd_consent_source, pd_consent_ip, pd_consent_at AS at FROM leads WHERE id = $1', [l.rows[0].id]);
    expect(after.rows[0]).toMatchObject({ pd_consent_source: 'transfer-page', pd_consent_ip: '198.51.100.1' });
    expect(new Date(after.rows[0].at).toISOString()).toBe(formAt.toISOString());
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
  it('перенос и отмена подтверждённой брони по запросу мест доходят до ключа (29.10)', async () => {
    const { issueRequestKey, readRequestStatus } = await import('@/lib/mcp/request-status');
    const { rescheduleBooking, cancelBooking } = await import('@/lib/bookings/booking.service');
    const admin = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ('status-admin@notify.test', 'Админ теста', 'x', 'admin') RETURNING id::text AS id`,
    )).rows[0].id;
    const op = (await pool.query<{ operator_id: string }>('SELECT operator_id::text FROM operator_tours WHERE id = $1', [tourId])).rows[0].operator_id;
    // Оператор ответил «Есть места»: бронь заведена и подтверждена (как в seat-requests/service).
    const bookingId = (await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, end_date, duration_days, participants, base_total_price, final_price,
                                      booking_status, payment_status, tourist_name, tourist_phone)
       VALUES ($1, '2027-08-10', '2027-08-10', 1, 2, 30000, 30000, 'confirmed', 'pending', 'Иван Тестовый', '+79990001122')
       RETURNING id::text AS id`, [tourId],
    )).rows[0].id;
    const seatId = (await pool.query<{ id: string }>(
      `INSERT INTO tour_seat_requests (tour_id, operator_id, tour_date, participants, tourist_name, tourist_phone, reply_channel, status,
                                       status_token_hash, deadline_at, answered_at, booking_id, source, pd_consent_at)
       VALUES ($1, $2, '2027-08-10', 2, 'Иван Тестовый', '+79990001122', 'phone', 'confirmed',
               repeat('c', 64), NOW() + INTERVAL '2 hours', NOW(), $3::bigint, 'mcp', NOW()) RETURNING id`,
      [tourId, op, bookingId],
    )).rows[0].id;
    const key = (await issueRequestKey({ seatRequestId: seatId }, 'create_booking_request')) ?? '';
    expect(await readRequestStatus(key)).toMatchObject({ state: 'confirmed', date: '2027-08-10', requested_date: '2027-08-10' });

    // Перенос — единственной дверью переноса, как её зовёт оператор или админ.
    await rescheduleBooking(bookingId, admin, 'admin', { targetTourId: String(tourId), targetDate: '2027-08-14' });
    const moved = await readRequestStatus(key);
    expect(moved).toMatchObject({ state: 'confirmed', date: '2027-08-14', requested_date: '2027-08-10', tour: 'Вулкан Горелый' });
    expect(moved.human).toContain('в заявке 2027-08-10, в брони 2027-08-14');

    await cancelBooking(bookingId, admin, 'admin', 'Отмена в тесте статуса');
    const cancelled = await readRequestStatus(key);
    expect(cancelled.state).toBe('cancelled');
    expect(JSON.stringify(cancelled)).not.toMatch(/Иван|7999000/);
  });

  it('обёртка по номерам ключей: та же правда без отметки прочтения; лид ai_qualified — ждёт оператора', async () => {
    const { issueRequestKey, buildRequestView, REQUEST_STATUS_BY_KEY_IDS_SQL } = await import('@/lib/mcp/request-status');
    const lead = (await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, comment, status) VALUES ('Пётр Тестовый', '+79990003344', 'Подбор тура в тесте', 'ai_qualified') RETURNING id`,
    )).rows[0].id;
    await issueRequestKey({ leadId: lead }, 'create_lead');
    const { rows: [k] } = await pool.query<{ id: string; read_count: number }>('SELECT id::text, read_count FROM agent_request_keys WHERE lead_id = $1', [lead]);
    const { rows } = await pool.query(REQUEST_STATUS_BY_KEY_IDS_SQL, [[k.id]]);
    expect(rows).toHaveLength(1);
    expect(rows[0].key_id).toBe(k.id);
    expect(buildRequestView(rows[0], Date.now())).toMatchObject({ state: 'awaiting_operator', kind: 'lead' });
    const after = await pool.query<{ read_count: number }>('SELECT read_count FROM agent_request_keys WHERE id = $1', [k.id]);
    expect(Number(after.rows[0].read_count)).toBe(Number(k.read_count));
    // Истёкший ключ сверка не читает.
    await pool.query(`UPDATE agent_request_keys SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [k.id]);
    expect((await pool.query(REQUEST_STATUS_BY_KEY_IDS_SQL, [[k.id]])).rows).toHaveLength(0);
  });
  it('подписка (1348): миграция повторяется; вторым запросом к ключу; шифртекст; база отсчёта; notify в статусе', async () => {
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    const { readFileSync } = await import('node:fs');
    await pool.query(readFileSync('migrations/1348_agent_request_notify.sql', 'utf8'));
    const { issueRequestKeyRecord, readRequestStatus } = await import('@/lib/mcp/request-status');
    const { subscribeNotify } = await import('@/lib/mcp/request-notify');
    const { decryptBound } = await import('@/lib/encryption');
    const lead = (await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, comment, status, source_data)
       VALUES ('Анна Тестовая', '+79990005566', '[Заявка на бронь] тест подписки', 'new', '{"tool":"create_booking_request","date":"2027-09-01"}') RETURNING id`,
    )).rows[0].id;
    const issued = await issueRequestKeyRecord({ leadId: lead }, 'create_booking_request');
    expect(issued?.keyId).toMatch(/^[0-9a-f-]{36}$/);
    // Значение query — не из hex-алфавита: шифртекст — hex, и «abc» в нём
    // встречалось случайно (тест краснел через раз).
    const url = 'https://hooks.agent-example.ru/in?t=xyz';
    const sub = await subscribeNotify(issued!, url);
    if (!sub.ok) throw new Error(`подписка не заведена: ${sub.reason}`);
    const { rows: [n] } = await pool.query<{ ref: string; url_enc: string; secret_enc: string; url_host: string; last_state: string; last_fingerprint: string; baseline_at: Date | null; same_expiry: boolean }>(
      `SELECT n.ref, n.url_enc, n.secret_enc, n.url_host, n.last_state, n.last_fingerprint, n.baseline_at, n.expires_at = k.expires_at AS same_expiry
         FROM agent_request_notify n JOIN agent_request_keys k ON k.id = n.key_id WHERE n.key_id = $1`, [issued!.keyId],
    );
    expect(n).toMatchObject({ ref: sub.ref, url_host: 'hooks.agent-example.ru', last_state: 'awaiting_operator', same_expiry: true });
    expect(n.baseline_at).not.toBeNull();
    expect(n.last_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(n.url_enc).not.toMatch(/xyz|hooks/);
    expect(decryptBound(n.url_enc, n.ref)).toBe(url);
    expect(decryptBound(n.secret_enc, n.ref)).toBe(sub.signingKey);
    const v = await readRequestStatus(issued!.key);
    expect(v.notify).toEqual({ ref: sub.ref, active: true, disabled_reason: null });
    expect(v.requested_date).toBe('2027-09-01');
    expect(JSON.stringify(v)).not.toMatch(/hooks\.agent|whsec_/);
  });

  it('подписка (1348): CHECK держат словарь причин, форму ref и «живая — с адресом»; удалили заявку — ключ и подписка ушли', async () => {
    const lead = (await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, comment, status) VALUES ('Олег Тестовый', '+79990007788', 'Подбор для проверки CHECK', 'new') RETURNING id`,
    )).rows[0].id;
    const key = (await pool.query<{ id: string }>(
      `INSERT INTO agent_request_keys (key_hash, lead_id, tool_name, expires_at) VALUES (repeat('d', 64), $1, 'create_lead', NOW() + INTERVAL '1 day') RETURNING id`, [lead],
    )).rows[0].id;
    const insert = (ref: string, urlEnc: string | null, disabledReason: string | null) => pool.query(
      `INSERT INTO agent_request_notify (key_id, ref, url_enc, url_host, secret_enc, expires_at, disabled_at, disabled_reason)
       VALUES ($1, $2, $3, 'h.example-agent.ru', $3, NOW() + INTERVAL '1 day', CASE WHEN $4::varchar IS NULL THEN NULL ELSE NOW() END, $4::varchar)`,
      [key, ref, urlEnc, disabledReason],
    );
    await expect(insert('nr_AAAAAAAAAAAAAAAAAAAAAA', 'enc', 'other')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('nr_AAAAAAAAAAAAAAAAAAAAAA', null, null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('bad ref', 'enc', null)).rejects.toMatchObject({ code: '23514' });
    await insert('nr_AAAAAAAAAAAAAAAAAAAAAA', 'enc', null);
    await expect(pool.query(`UPDATE agent_request_notify SET last_error = 'https://h/x' WHERE key_id = $1`, [key])).rejects.toMatchObject({ code: '23514' });
    await pool.query('DELETE FROM leads WHERE id = $1', [lead]);
    expect((await pool.query('SELECT 1 FROM agent_request_keys WHERE id = $1', [key])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM agent_request_notify WHERE key_id = $1', [key])).rows).toHaveLength(0);
  });
  it('сцена уведомлений: подписка с заявкой; изменения — по одному POST с подписью и без ПД; повтор — ноль', async () => {
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    const { createHmac } = await import('node:crypto');
    const { issueKeyWithNotify, runRequestNotify } = await import('@/lib/mcp/request-notify');
    const { readRequestStatus } = await import('@/lib/mcp/request-status');
    const { rescheduleBooking, cancelBooking } = await import('@/lib/bookings/booking.service');
    const admin = (await pool.query<{ id: string }>(`SELECT id::text FROM users WHERE email = 'status-admin@notify.test'`)).rows[0].id;
    const op = (await pool.query<{ operator_id: string }>('SELECT operator_id::text FROM operator_tours WHERE id = $1', [tourId])).rows[0].operator_id;

    // Две заявки с notify_url: запрос мест (ждёт оператора) и запрос мест, по
    // которому бронь уже подтверждена.
    const seatPending = (await pool.query<{ id: string }>(
      `INSERT INTO tour_seat_requests (tour_id, operator_id, tour_date, participants, tourist_name, tourist_phone, reply_channel, status,
                                       status_token_hash, deadline_at, source, pd_consent_at)
       VALUES ($1, $2, '2027-09-01', 3, 'Мария Тестовая', '+79990009911', 'phone', 'pending', repeat('e', 64), NOW() + INTERVAL '2 hours', 'mcp', NOW()) RETURNING id`,
      [tourId, op],
    )).rows[0].id;
    const bookingId = (await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, end_date, duration_days, participants, base_total_price, final_price,
                                      booking_status, payment_status, tourist_name, tourist_phone)
       VALUES ($1, '2027-09-10', '2027-09-10', 1, 2, 30000, 30000, 'confirmed', 'pending', 'Мария Тестовая', '+79990009911') RETURNING id::text AS id`, [tourId],
    )).rows[0].id;
    const seatConfirmed = (await pool.query<{ id: string }>(
      `INSERT INTO tour_seat_requests (tour_id, operator_id, tour_date, participants, tourist_name, tourist_phone, reply_channel, status,
                                       status_token_hash, deadline_at, answered_at, booking_id, source, pd_consent_at)
       VALUES ($1, $2, '2027-09-10', 2, 'Мария Тестовая', '+79990009911', 'phone', 'confirmed', repeat('f', 64), NOW() + INTERVAL '2 hours', NOW(), $3::bigint, 'mcp', NOW()) RETURNING id`,
      [tourId, op, bookingId],
    )).rows[0].id;

    const tailA = await issueKeyWithNotify({ seatRequestId: seatPending }, 'create_booking_request', 'https://hooks.agent-example.ru/a?t=1');
    const tailB = await issueKeyWithNotify({ seatRequestId: seatConfirmed }, 'create_booking_request', 'https://hooks.agent-example.ru/b?t=2');
    const parse = (tail: string) => ({
      key: /Ключ статуса заявки: ([A-Za-z0-9_-]+)/.exec(tail)![1]!,
      ref: /номер подписки (nr_[A-Za-z0-9_-]+)/.exec(tail)![1]!,
      signing: /ключ подписи (whsec_[A-Za-z0-9+/=]+)/.exec(tail)![1]!,
    });
    const A = parse(tailA);
    const B = parse(tailB);

    const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const answer: import('@/lib/mcp/notify-send').SendOutcome = { kind: 'delivered', code: 'http_204' };
    const send = async (url: string, body: string, headers: Record<string, string>) => { sent.push({ url, body, headers }); return answer; };
    const mine = (ref: string) => sent.filter((x) => JSON.parse(x.body).ref === ref);
    const verify = (x: { body: string; headers: Record<string, string> }, signing: string) => {
      const expected = createHmac('sha256', Buffer.from(signing.slice('whsec_'.length), 'base64'))
        .update(`${x.headers['webhook-id']}.${x.headers['webhook-timestamp']}.${x.body}`).digest('base64');
      expect(x.headers['webhook-signature']).toBe(`v1,${expected}`);
    };

    // Ничего не менялось с подписки — ни одного POST.
    const r0 = await runRequestNotify({ send });
    expect(r0.status).toBe('ok');
    expect(mine(A.ref).length + mine(B.ref).length).toBe(0);

    // Оператор предложил другую дату — ровно одно уведомление A.
    await pool.query(`UPDATE tour_seat_requests SET status = 'other_date', alt_date = '2027-09-03', answered_at = NOW() WHERE id = $1`, [seatPending]);
    await runRequestNotify({ send });
    expect(mine(A.ref)).toHaveLength(1);
    const a1 = mine(A.ref)[0]!;
    expect(a1.url).toBe('https://hooks.agent-example.ru/a?t=1');
    expect(JSON.parse(a1.body)).toMatchObject({ state: 'other_date', previous_state: 'awaiting_operator', alt_date: '2027-09-03', changed: ['state', 'alt_date'], tour: 'Вулкан Горелый', participants: 3 });
    verify(a1, A.signing);
    expect(a1.body).not.toMatch(/Мария|7999000|request-status|whsec_/);
    expect(a1.body).not.toContain(A.key);

    // Повтор прогона без изменений — ноль.
    await runRequestNotify({ send });
    expect(mine(A.ref)).toHaveLength(1);

    // Перенос подтверждённой брони — одно уведомление B с новой датой.
    await rescheduleBooking(bookingId, admin, 'admin', { targetTourId: String(tourId), targetDate: '2027-09-12' });
    await runRequestNotify({ send });
    expect(mine(B.ref)).toHaveLength(1);
    expect(JSON.parse(mine(B.ref)[0]!.body)).toMatchObject({ state: 'confirmed', previous_state: 'confirmed', date: '2027-09-12', previous_date: '2027-09-10', requested_date: '2027-09-10', changed: ['date'] });
    verify(mine(B.ref)[0]!, B.signing);

    // Отмена — ещё одно, с новым webhook-id.
    await cancelBooking(bookingId, admin, 'admin', 'Отмена в сцене уведомлений');
    await runRequestNotify({ send });
    expect(mine(B.ref)).toHaveLength(2);
    expect(JSON.parse(mine(B.ref)[1]!.body)).toMatchObject({ state: 'cancelled', previous_state: 'confirmed', changed: ['state'] });
    expect(mine(B.ref)[1]!.headers['webhook-id']).not.toBe(mine(B.ref)[0]!.headers['webhook-id']);
    const { rows: [nb] } = await pool.query<{ delivered_count: number; last_state: string; last_body_sha256: string }>(
      'SELECT delivered_count, last_state, last_body_sha256 FROM agent_request_notify WHERE ref = $1', [B.ref]);
    expect(nb).toMatchObject({ delivered_count: 2, last_state: 'cancelled' });
    expect(nb.last_body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await readRequestStatus(B.key)).notify).toEqual({ ref: B.ref, active: true, disabled_reason: null });
  });

  it('сцена уведомлений: отказ приёмника — повтор через 30 мин; предел — undeliverable; 410 — сразу; захват; уборка', async () => {
    const { issueKeyWithNotify, runRequestNotify, CLAIM_SQL, NOTIFY_MAX_FAILURES } = await import('@/lib/mcp/request-notify');
    const { readRequestStatus } = await import('@/lib/mcp/request-status');
    const lead = async () => (await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, comment, status) VALUES ('Глеб Тестовый', '+79990004455', 'Подбор для сцены отказа', 'new') RETURNING id`,
    )).rows[0].id;
    const l1 = await lead();
    const l2 = await lead();
    const t1 = await issueKeyWithNotify({ leadId: l1 }, 'create_lead', 'https://down.agent-example.ru/in');
    const t2 = await issueKeyWithNotify({ leadId: l2 }, 'create_lead', 'https://gone.agent-example.ru/in');
    const ref1 = /номер подписки (nr_[A-Za-z0-9_-]+)/.exec(t1)![1]!;
    const ref2 = /номер подписки (nr_[A-Za-z0-9_-]+)/.exec(t2)![1]!;
    const key2 = /Ключ статуса заявки: ([A-Za-z0-9_-]+)/.exec(t2)![1]!;
    await pool.query(`UPDATE leads SET status = 'contacted' WHERE id = ANY($1::uuid[])`, [[l1, l2]]);

    const send = async (url: string): Promise<import('@/lib/mcp/notify-send').SendOutcome> =>
      (url.includes('gone.') ? { kind: 'gone', code: 'http_410' } : { kind: 'retry', code: 'http_503', network: false });
    await runRequestNotify({ send });
    const row = async (ref: string) => (await pool.query<{ attempts: number; gap_min: number | null; disabled_reason: string | null; url_enc: string | null; secret_enc: string | null; last_error: string | null }>(
      `SELECT attempts, EXTRACT(EPOCH FROM (next_attempt_at - last_attempt_at)) / 60 AS gap_min, disabled_reason, url_enc, secret_enc, last_error
         FROM agent_request_notify WHERE ref = $1`, [ref])).rows[0];
    expect(await row(ref1)).toMatchObject({ attempts: 1, disabled_reason: null, last_error: 'http_503' });
    expect(Number((await row(ref1))!.gap_min)).toBeCloseTo(30, 0);
    expect(await row(ref2)).toMatchObject({ disabled_reason: 'gone', url_enc: null, secret_enc: null, last_error: 'http_410' });
    expect((await readRequestStatus(key2)).notify).toEqual({ ref: ref2, active: false, disabled_reason: 'gone' });

    // Предел: шестая неудача уже была — седьмая отключает.
    await pool.query(`UPDATE agent_request_notify SET attempts = $2, next_attempt_at = NOW() - INTERVAL '1 minute' WHERE ref = $1`, [ref1, NOTIFY_MAX_FAILURES - 1]);
    await runRequestNotify({ send });
    expect(await row(ref1)).toMatchObject({ disabled_reason: 'undeliverable', url_enc: null, secret_enc: null });

    // Захват построчный: два параллельных UPDATE … RETURNING — строку получает один.
    const l3 = await lead();
    const t3 = await issueKeyWithNotify({ leadId: l3 }, 'create_lead', 'https://claim.agent-example.ru/in');
    const ref3 = /номер подписки (nr_[A-Za-z0-9_-]+)/.exec(t3)![1]!;
    const { rows: [r3] } = await pool.query<{ id: string; delivered_count: number; attempts: number; fp: string | null }>(
      'SELECT id::text, delivered_count, attempts, last_fingerprint::text AS fp FROM agent_request_notify WHERE ref = $1', [ref3]);
    const seen = [[r3.id], [Number(r3.delivered_count)], [Number(r3.attempts)], [r3.fp]];
    const [c1, c2] = await Promise.all([pool.query(CLAIM_SQL, seen), pool.query(CLAIM_SQL, seen)]);
    expect(c1.rows.length + c2.rows.length).toBe(1);

    // Уборка: отключённая больше 30 дней назад — удалена; моложе — на месте.
    await pool.query(`UPDATE agent_request_notify SET disabled_at = NOW() - INTERVAL '31 days' WHERE ref = $1`, [ref1]);
    const r = await runRequestNotify({ send });
    expect(r.deleted_after_retention).toBeGreaterThanOrEqual(1);
    expect((await pool.query('SELECT 1 FROM agent_request_notify WHERE ref = $1', [ref1])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM agent_request_notify WHERE ref = $1', [ref2])).rows).toHaveLength(1);
  });

  // ── Ревью 29.10 ──────────────────────────────────────────────────────────
  const refOf = (tail: string) => /номер подписки (nr_[A-Za-z0-9_-]+)/.exec(tail)![1]!;
  const keyOf = (tail: string) => /Ключ статуса заявки: ([A-Za-z0-9_-]+)/.exec(tail)![1]!;
  type Sent = { url: string; body: string; headers: Record<string, string> };

  it('ревью 29.10: заявка на бронь — тур один у статуса и уведомления; бронь на тот же тур — changed без tour', async () => {
    const { issueKeyWithNotify, runRequestNotify } = await import('@/lib/mcp/request-notify');
    const { readRequestStatus } = await import('@/lib/mcp/request-status');
    const lead = (await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, comment, route_title, status, source_data)
       VALUES ('Вера Тестовая', '+79990002211', '[Заявка на бронь] тур ревью', 'Вулкан Горелый', 'new',
               jsonb_build_object('source', 'mcp', 'tool', 'create_booking_request', 'tour_id', $1::bigint, 'date', '2027-09-21', 'participants', 2)) RETURNING id`,
      [tourId],
    )).rows[0].id;
    const tail = await issueKeyWithNotify({ leadId: lead }, 'create_booking_request', 'https://tour.agent-example.ru/in');
    const ref = refOf(tail);
    const key = keyOf(tail);
    const sent: Sent[] = [];
    const send = async (url: string, body: string, headers: Record<string, string>) => { sent.push({ url, body, headers }); return { kind: 'delivered', code: 'http_200' } as const; };
    const mine = () => sent.filter((x) => JSON.parse(x.body).ref === ref).map((x) => JSON.parse(x.body));

    expect((await readRequestStatus(key)).tour).toBe('Вулкан Горелый');
    await pool.query(`UPDATE leads SET status = 'contacted' WHERE id = $1`, [lead]);
    await runRequestNotify({ send });
    expect(mine()).toHaveLength(1);
    expect(mine()[0]).toMatchObject({ tour: 'Вулкан Горелый', changed: ['state'] });

    await pool.query(
      `INSERT INTO operator_bookings (operator_tour_id, lead_id, booking_date, participants, base_total_price, final_price, booking_status, payment_status, tourist_name, tourist_phone)
       VALUES ($1, $2, '2027-09-21', 2, 30000, 30000, 'confirmed', 'pending', 'Вера Тестовая', '+79990002211')`, [tourId, lead],
    );
    await runRequestNotify({ send });
    expect(mine()).toHaveLength(2);
    expect(mine()[1]).toMatchObject({ state: 'confirmed', tour: 'Вулкан Горелый', date: '2027-09-21' });
    expect(mine()[1].changed).not.toContain('tour');
    expect((await readRequestStatus(key)).tour).toBe(mine()[1].tour);
  });

  it('ревью 29.10: ступенчатая гонка захвата — одна отправка; повтор — в прогон, ближайший к сроку', async () => {
    const { issueKeyWithNotify, runRequestNotify, CLAIM_SQL } = await import('@/lib/mcp/request-notify');
    const { pool: appPool } = await import('@/lib/db-pool');
    const lead = async () => (await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, comment, status) VALUES ('Лев Тестовый', '+79990006677', 'Подбор для гонки', 'new') RETURNING id`,
    )).rows[0].id;

    for (const answer of [{ kind: 'delivered', code: 'http_200' }, { kind: 'retry', code: 'http_503', network: false }] as const) {
      const l = await lead();
      const ref = refOf(await issueKeyWithNotify({ leadId: l }, 'create_lead', `https://race-${answer.code}.agent-example.ru/in`));
      await pool.query(`UPDATE leads SET status = 'contacted' WHERE id = $1`, [l]);
      const sent: Sent[] = [];
      const send = async (url: string, body: string, headers: Record<string, string>) => { sent.push({ url, body, headers }); return answer; };
      let raced = false;
      const q = async (sql: string, params?: unknown[]) => {
        if (sql === CLAIM_SQL && !raced) {
          raced = true;
          await runRequestNotify({ send });
        }
        return appPool.query(sql, params);
      };
      await runRequestNotify({ query: q, send });
      expect(sent.filter((x) => JSON.parse(x.body).ref === ref), answer.code).toHaveLength(1);
      const { rows: [n] } = await pool.query<{ delivered_count: number; attempts: number }>('SELECT delivered_count, attempts FROM agent_request_notify WHERE ref = $1', [ref]);
      expect(Number(n.delivered_count) + Number(n.attempts), answer.code).toBe(1);
    }

    // Повтор: неудача ставит срок по своим часам; следующий прогон шага
    // начинается через шаг расписания от начала прошлого — чуть раньше срока.
    const l = await lead();
    const ref = refOf(await issueKeyWithNotify({ leadId: l }, 'create_lead', 'https://slack.agent-example.ru/in'));
    await pool.query(`UPDATE leads SET status = 'contacted' WHERE id = $1`, [l]);
    const sent: Sent[] = [];
    const send = async (url: string, body: string, headers: Record<string, string>) => {
      sent.push({ url, body, headers });
      return url.includes('slack.') ? { kind: 'retry', code: 'http_503', network: false } as const : { kind: 'delivered', code: 'http_200' } as const;
    };
    const mine = () => sent.filter((x) => JSON.parse(x.body).ref === ref);
    const runStart = Date.now();
    await runRequestNotify({ send });
    expect(mine()).toHaveLength(1);
    await runRequestNotify({ send, now: () => runStart + 10 * 60_000 });
    expect(mine()).toHaveLength(1);
    await runRequestNotify({ send, now: () => runStart + 30 * 60_000 });
    expect(mine()).toHaveLength(2);
  });

  it('ревью 29.10: молчание сети по таблице; разбор подписки по номеру; имя хоста на пределе DNS ложится в колонку', async () => {
    const { issueKeyWithNotify, runRequestNotify, readNotifyCensus, subscribeNotify } = await import('@/lib/mcp/request-notify');
    const { issueRequestKeyRecord } = await import('@/lib/mcp/request-status');
    const mk = async (host: string) => {
      const l = (await pool.query<{ id: string }>(
        `INSERT INTO leads (name, phone, comment, status) VALUES ('Нина Тестовая', '+79990008899', 'Подбор для молчания', 'new') RETURNING id`,
      )).rows[0].id;
      return { l, ref: refOf(await issueKeyWithNotify({ leadId: l }, 'create_lead', `https://${host}/in?t=x`)) };
    };
    const k1 = await mk('k1.agent-example.ru');
    const k2 = await mk('k2.agent-example.ru');
    const ok = async () => ({ kind: 'delivered', code: 'http_200' } as const);
    const down = async () => ({ kind: 'retry', code: 'timeout', network: true } as const);

    // Новые хосты, не принявшие ни разу, глотают TCP — признака нет: чужой
    // адрес не включает тревогу (критика 29.10).
    await pool.query(`UPDATE leads SET status = 'contacted' WHERE id = ANY($1::uuid[])`, [[k1.l, k2.l]]);
    expect((await runRequestNotify({ send: down })).stall).toBeNull();
    // Ожили и приняли — теперь оба «принимали раньше».
    expect((await runRequestNotify({ send: ok, now: () => Date.now() + 30 * 60_000 })).stall).toBeNull();
    expect((await readNotifyCensus(k1.ref))).toMatchObject({ delivered_count: 1, attempts: 0, failing_since: null });
    // Сеть легла: оба в сетевых отказах, доставок нет — признак.
    await pool.query(`UPDATE leads SET status = 'lost' WHERE id = ANY($1::uuid[])`, [[k1.l, k2.l]]);
    const r = await runRequestNotify({ send: down });
    expect(r.status).toBe('ok');
    expect(r.stall).toMatchObject({ hosts: 2 });
    const c = await readNotifyCensus(k1.ref);
    expect(c).toMatchObject({ ref: k1.ref, active: true, last_error: 'timeout', attempts: 1, delivered_count: 1 });
    expect(c!.failing_since).not.toBeNull();
    expect(c!.last_delivered_at).not.toBeNull();
    expect(c!.last_body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(c)).not.toMatch(/agent-example|t=x/);
    // Ожила — серия закрыта, признака нет.
    expect((await runRequestNotify({ send: ok, now: () => Date.now() + 30 * 60_000 })).stall).toBeNull();
    const { rows: [n] } = await pool.query<{ failing_since: Date | null; attempts: number }>('SELECT failing_since, attempts FROM agent_request_notify WHERE ref = $1', [k1.ref]);
    expect(n).toMatchObject({ failing_since: null, attempts: 0 });
    expect(await readNotifyCensus('nr_ZZZZZZZZZZZZZZZZZZZZZZ')).toBeNull();

    // Имя на пределе DNS (253 знака) проходит форму — и ложится в url_host без 22001.
    let host = 'ru';
    while (host.length < 253) host = `${'h'.repeat(Math.min(63, 253 - host.length - 1))}.${host}`;
    const l = (await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, comment, status) VALUES ('Ян Тестовый', '+79990001100', 'Подбор для длины', 'new') RETURNING id`,
    )).rows[0].id;
    const issued = await issueRequestKeyRecord({ leadId: l }, 'create_lead');
    const sub = await subscribeNotify(issued!, `https://${host}/in`);
    expect(sub.ok).toBe(true);
  });
});
