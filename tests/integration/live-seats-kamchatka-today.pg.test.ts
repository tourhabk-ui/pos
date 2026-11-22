/**
 * «Другая дата» в чате оператора считает «сегодня» по Камчатке (разбор 03.11).
 *
 * `CURRENT_DATE` берёт пояс сессии базы. Здесь пояс базы поставлен на
 * Etc/GMT+12 (UTC−12): в любой момент он ровно на сутки позади Камчатки
 * (UTC+12), и «вчера по Камчатке» совпадает с `CURRENT_DATE`. Прежний запрос
 * предлагал оператору этот вчерашний день как открытый.
 *
 * Своя база `live_seats_today_test`. Запуск ТРЕБУЕТ KERNEL_PG_TEST_URL; без неё
 * файл честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[live-seats-kamchatka-today.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}
const TEST_DB = 'live_seats_today_test';
const KAM_TODAY = `(NOW() AT TIME ZONE 'Asia/Kamchatka')::date`;

withPg('«Другая дата»: сегодня — по Камчатке, не по поясу базы', () => {
  let pool: import('pg').Pool;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    const admin = new Pool({ connectionString: dbUrl, max: 1 });
    await admin.query(`ALTER DATABASE ${TEST_DB} SET timezone = 'Etc/GMT+12'`);
    await admin.end();
    // Новые соединения (и пул приложения ниже) получают пояс базы.
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    ids.user = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ('op-today@test', 'op', 'x', 'operator') RETURNING id`,
    )).rows[0].id;
    ids.operator = (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, user_id, profile_status) VALUES ('Оператор', 'operator', '{}', $1, 'approved') RETURNING id`, [ids.user],
    )).rows[0].id;
    ids.tour = (await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, is_active, is_published, activity_type, duration_hours)
       VALUES ($1, 'Тур', 10000, 10, TRUE, TRUE, 'hiking', 6) RETURNING id::text`, [ids.operator],
    )).rows[0].id;
    for (const offset of [-1, 0, 3]) {
      await pool.query(
        `INSERT INTO tour_availability (operator_tour_id, date, available_slots) VALUES ($1::bigint, ${KAM_TODAY} + $2::int, 8)`,
        [ids.tour, offset],
      );
    }
    ids.booking = (await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, booking_status, final_price, tourist_name, tourist_email)
       VALUES ($1::bigint, ${KAM_TODAY} + 10, 2, 'new', 20000, 'Турист', 'x@test') RETURNING id::text`, [ids.tour],
    )).rows[0].id;
  }, 240_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await appPool.end().catch(() => undefined);
    await pool?.end();
    await dropTestDatabase(PG_URL, TEST_DB);
  });

  it('пояс базы на сутки позади Камчатки — CURRENT_DATE совпадает со «вчера по Камчатке»', async () => {
    const r = await pool.query<{ same: boolean }>(`SELECT CURRENT_DATE = ${KAM_TODAY} - 1 AS same`);
    expect(r.rows[0].same).toBe(true);
  });

  it('вчерашний по Камчатке день не предлагается, сегодняшний и будущий — да', async () => {
    const { nextOpenDates } = await import('@/lib/operators/live-seats');
    const expected = (await pool.query<{ d: string }>(
      `SELECT (${KAM_TODAY} + o)::text AS d FROM unnest(ARRAY[0, 3]) o ORDER BY o`,
    )).rows.map((x) => x.d);
    const got = await nextOpenDates(ids.operator, ids.booking);
    expect(got).not.toBe('failed');
    expect(Array.isArray(got) ? got.map((x) => x.date) : got).toEqual(expected);
  });
});
