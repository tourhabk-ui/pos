/**
 * Обстановка на день выезда на настоящем PostgreSQL (#2969).
 *
 * Мок ответил бы на любой SQL; здесь судит база:
 *  - выезды: брони new/confirmed/pending_payment и живые заявки с датой и
 *    туром в source_data; отменённые брони, своя заявка, «lost» — мимо;
 *    координаты — тура, иначе главного места; зона — места;
 *  - туристы послезавтра: бронь с чатом бота, бронь без канала, заявка с
 *    MAX гостя;
 *  - запись обстановки и чтение для «Сегодня» (повторная запись — обновление);
 *  - журнал и последний отправленный отпечаток;
 *  - выезды «Сегодня» оператора несут id тура.
 *
 * Своя база `trip_situation_test`. Запуск ТРЕБУЕТ KERNEL_PG_TEST_URL; без неё
 * файл честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[trip-situation.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}
const TEST_DB = 'trip_situation_test';
const D1 = '2099-11-04';
const D2 = '2099-11-05';

withPg('обстановка на день выезда — SQL', () => {
  let pool: import('pg').Pool;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    ids.user = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role, telegram_id) VALUES ('op@test', 'op', 'x', 'operator', 9001) RETURNING id`,
    )).rows[0].id;
    ids.tourist = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role, telegram_id) VALUES ('t@test', 't', 'x', 'tourist', 7007) RETURNING id`,
    )).rows[0].id;
    ids.operator = (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, user_id, profile_status) VALUES ('Оператор', 'operator', '{}', $1, 'approved') RETURNING id`, [ids.user],
    )).rows[0].id;
    ids.place = (await pool.query<{ id: string }>(
      `INSERT INTO places (id, name, lat, lng, ark_id, location_type, zone, is_visible)
       VALUES (gen_random_uuid(), 'Авачинский', 53.25, 158.83, gen_random_uuid(), 'volcano', 'avachinsky', TRUE) RETURNING id::text`,
    )).rows[0].id;
    const tour = async (title: string, place: string | null) => (await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, is_active, is_published, activity_type, duration_hours, main_place_id)
       VALUES ($1, $2, 10000, 10, TRUE, TRUE, 'hiking', 6, $3::uuid) RETURNING id::text`, [ids.operator, title, place],
    )).rows[0].id;
    ids.tourA = await tour('Авачинский', ids.place);
    ids.tourB = await tour('Без места', null);
    const booking = async (tourId: string, date: string, status: string, meta: Record<string, unknown> | null, userId: string | null) => (await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, booking_status, final_price, tourist_name, tourist_email, metadata, user_id)
       VALUES ($1::bigint, $2::date, 2, $3, 20000, 'Турист', 'x@test', $4::jsonb, $5::uuid) RETURNING id::text`,
      [tourId, date, status, meta ? JSON.stringify(meta) : null, userId],
    )).rows[0].id;
    ids.bBot = await booking(ids.tourA, D2, 'confirmed', { tg_chat_id: 555, platform: 'max' }, null);
    ids.bAccount = await booking(ids.tourA, D2, 'new', null, ids.tourist);
    ids.bCancelled = await booking(ids.tourA, D2, 'cancelled', { tg_chat_id: 556 }, null);
    ids.bTomorrow = await booking(ids.tourB, D1, 'confirmed', null, null);
    const lead = async (status: string, sd: Record<string, unknown>, isSelf: boolean, guest: number | null) => (await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, comment, status, operator_id, source_data, is_self, guest_max_chat_id)
       VALUES ('Анна', '+79990001122', 'заявка', $1, $2::uuid, $3::jsonb, $4, $5) RETURNING id::text`,
      [status, ids.operator, JSON.stringify(sd), isSelf, guest],
    )).rows[0].id;
    ids.lLive = await lead('new', { tool: 'create_booking_request', tour_id: Number(ids.tourA), date: D2 }, false, 8008);
    ids.lLost = await lead('lost', { tour_id: Number(ids.tourA), date: D2 }, false, 8009);
    ids.lSelf = await lead('new', { tour_id: Number(ids.tourA), date: D2 }, true, 8010);
  }, 240_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await dropTestDatabase(PG_URL, TEST_DB);
  });

  it('выезды завтра и послезавтра: брони и живые заявки, координаты и зона места', async () => {
    const { loadDepartingTours } = await import('@/lib/trips/situation-store');
    const tours = await loadDepartingTours([D1, D2]);
    expect(tours.map((t) => [t.tourId, t.date, t.travellers])).toEqual([
      [Number(ids.tourB), D1, 1],
      [Number(ids.tourA), D2, 3], // две брони и одна живая заявка; отменённая, «lost» и своя — мимо
    ]);
    const a = tours.find((t) => t.tourId === Number(ids.tourA))!;
    expect(a).toMatchObject({ lat: 53.25, lng: 158.83, zone: 'avachinsky', operatorId: ids.operator });
    expect(tours.find((t) => t.tourId === Number(ids.tourB))).toMatchObject({ lat: null, lng: null, zone: null });
  });

  it('туристы послезавтра: чат бота, аккаунт с Telegram, MAX гостя заявки', async () => {
    const { loadTouristRecipients } = await import('@/lib/trips/situation-store');
    const r = await loadTouristRecipients(D2);
    const by = new Map(r.map((x) => [x.ref, x]));
    expect(by.get(ids.bBot)).toMatchObject({ kind: 'tourist_booking', channel: 'max', chatId: '555' });
    expect(by.get(ids.bAccount)).toMatchObject({ kind: 'tourist_booking', channel: 'telegram', chatId: '7007' });
    expect(by.get(ids.lLive)).toMatchObject({ kind: 'tourist_lead', channel: 'max', chatId: '8008' });
    expect(by.has(ids.bCancelled)).toBe(false);
    expect(by.has(ids.lLost)).toBe(false);
    expect(by.has(ids.lSelf)).toBe(false);
  });

  it('обстановка пишется и читается; повторная запись обновляет строку', async () => {
    const { saveSituation } = await import('@/lib/trips/situation-store');
    const { readStoredSituations } = await import('@/lib/trips/situation-read');
    await saveSituation(Number(ids.tourA), D2, { kind: 'unknown', risks: [], unchecked: ['погоду — сбой'] });
    await saveSituation(Number(ids.tourA), D2, { kind: 'risk', risks: ['погода: ветер до 72 км/ч'], unchecked: [] });
    const got = await readStoredSituations([Number(ids.tourA), Number(ids.tourB)], [D1, D2]);
    expect(got).not.toBe('failed');
    expect((got as Array<{ kind: string; line: string; checkedAt: string }>)).toEqual([
      expect.objectContaining({ tourId: Number(ids.tourA), date: D2, kind: 'risk', line: 'есть риски — погода: ветер до 72 км/ч.' }),
    ]);
    expect(Number.isNaN(new Date((got as Array<{ checkedAt: string }>)[0].checkedAt.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).getTime())).toBe(false);
  });

  it('журнал и последний отправленный отпечаток', async () => {
    const { logNotice, lastSentFingerprint } = await import('@/lib/trips/situation-store');
    expect(await lastSentFingerprint('tourist_booking', ids.bBot, D2)).toBeNull();
    await logNotice({ kind: 'tourist_booking', ref: ids.bBot, tourId: Number(ids.tourA), date: D2, fingerprint: 'risk|a', outcome: 'sent', channel: 'max' });
    await logNotice({ kind: 'tourist_booking', ref: ids.bBot, tourId: Number(ids.tourA), date: D2, fingerprint: 'risk|b', outcome: 'failed', channel: 'max', reason: 'MAX не принял' });
    expect(await lastSentFingerprint('tourist_booking', ids.bBot, D2)).toBe('risk|a');
    await expect(logNotice({ kind: 'operator', ref: 'x', tourId: 1, date: D2, fingerprint: 'f', outcome: 'bogus' as never })).rejects.toThrow();
  });

  it('лента предупреждений и оценка зоны читаются на настоящей схеме', async () => {
    const { OFFICIAL_ALERTS_SQL, ZONE_DANGER_SQL, liveSources, situationFor } = await import('@/lib/trips/situation-store');
    await expect(pool.query(OFFICIAL_ALERTS_SQL)).resolves.toBeDefined();
    await expect(pool.query(ZONE_DANGER_SQL, ['avachinsky'])).resolves.toBeDefined();
    // Живые источники без прогноза (координат нет): погода «не проверена», лента и зона прочитаны.
    const s = await situationFor({ tourId: Number(ids.tourB), date: D1, title: 'Без места', operatorId: ids.operator,
      activityType: 'hiking', locationType: null, zone: null, lat: null, lng: null, travellers: 1 }, liveSources());
    expect(s).toEqual({ kind: 'unknown', risks: [], unchecked: ['погоду — у тура не записаны координаты'] });
  });

  it('выезды «Сегодня» оператора несут id тура', async () => {
    const { loadDepartures } = await import('@/lib/operators/live-seats');
    const d = await loadDepartures(ids.operator, [D1, D2]);
    expect(d).not.toBe('failed');
    expect(d as unknown[]).toEqual([
      { date: D1, tourId: Number(ids.tourB), title: 'Без места', people: 2, bookings: 1 },
      { date: D2, tourId: Number(ids.tourA), title: 'Авачинский', people: 2, bookings: 1 },
    ]);
  });
});
