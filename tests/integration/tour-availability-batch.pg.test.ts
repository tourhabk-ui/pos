/**
 * Даты тура пишутся одним выражением (аудит 15.10, 1.15, P3-14). На настоящем
 * PostgreSQL.
 *
 * До 1.15 блокировка диапазона дат делала по запросу на каждую дату разом
 * (`Promise.all`, до 366 штук) — в пул на 20 соединений, который делят SOS,
 * брони и кроны: остальные запросы ждали свободного соединения дольше 5 с и
 * получали отказ. Открытие дат шло циклом по запросу на дату без транзакции:
 * отказ на середине оставлял половину дат открытой.
 *
 * Теперь и то и другое — одно выражение `INSERT … SELECT FROM unnest(…)`.
 * Мок ответил бы на любой SQL, поэтому здесь судится сам запрос: вывод типов
 * параметров (42P08 — «inconsistent types deduced», CLAUDE.md §4), повтор
 * даты во входе, цена без права цен, повторное открытие заблокированной даты
 * и число обращений к базе на блокировку года.
 *
 * Своя база `tour_availability_batch_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

const { operatorId } = vi.hoisted(() => ({ operatorId: 'b1500000-0000-4000-8000-000000000001' }));
vi.mock('@/lib/operators/team-access', async (orig) => ({
  ...(await orig<typeof import('@/lib/operators/team-access')>()),
  requireOperatorTeam: vi.fn(async () => ({
    userId: 'b1500000-0000-4000-8000-0000000000aa', role: 'operator', partnerId: operatorId,
    access: { kind: 'owner', partnerId: operatorId },
  })),
}));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[tour-availability-batch.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'tour_availability_batch_test';

withPg('даты тура одним выражением (P3-14)', () => {
  let pool: import('pg').Pool;
  let tourId = '';

  interface DateRow { date: string; available_slots: number; price: string | null; is_cancelled: boolean; reason: string | null }
  async function rows(): Promise<DateRow[]> {
    const r = await pool.query<DateRow>(
      `SELECT date::text AS date, available_slots, base_price_override::text AS price, is_cancelled,
              cancellation_reason AS reason
         FROM tour_availability WHERE operator_tour_id = $1 ORDER BY date`,
      [tourId],
    );
    return r.rows;
  }

  function call(method: 'POST' | 'DELETE', body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/operator/calendar/block', {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    await pool.query(
      `INSERT INTO partners (id, name, category, contact, slug, is_public, is_verified, status)
       VALUES ($1, 'Тест Даты', 'operator', '{}'::jsonb, 'test-p314-operator', TRUE, TRUE, 'active')`,
      [operatorId],
    );
    const t = await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                   min_participants, max_participants, duration_hours, difficulty, is_active, is_published)
       VALUES ($1, 'P314 тур', 'p314-tour', 'hiking', 5000, 'per_person', 1, 10, 8, 'easy', TRUE, TRUE)
       RETURNING id::text`,
      [operatorId],
    );
    tourId = t.rows[0].id;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await appPool.end();
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  });

  it('открытие дат: одно выражение, повтор даты во входе — берётся последний', async () => {
    const { addAvailability } = await import('@/lib/api/operator-tours');
    await addAvailability(BigInt(tourId), [
      { date: '2027-07-01', available_slots: 5, price_override: 7000 },
      { date: '2027-07-02', available_slots: 6 },
      { date: '2027-07-01', available_slots: 8, price_override: 7500 },
    ], true, operatorId);
    expect(await rows()).toEqual([
      { date: '2027-07-01', available_slots: 8, price: '7500.00', is_cancelled: false, reason: null },
      { date: '2027-07-02', available_slots: 6, price: null, is_cancelled: false, reason: null },
    ]);
  });

  it('без права цен повторное открытие места меняет, цену даты — нет', async () => {
    const { addAvailability } = await import('@/lib/api/operator-tours');
    await addAvailability(BigInt(tourId), [{ date: '2027-07-01', available_slots: 3 }], false, operatorId);
    const d = (await rows()).find((r) => r.date === '2027-07-01');
    expect(d).toMatchObject({ available_slots: 3, price: '7500.00' });
  });

  it('блокировка года: 366 дат — один запрос записи, все закрыты с причиной', async () => {
    const dbPool = await import('@/lib/db-pool');
    const spy = vi.spyOn(dbPool.pool, 'query');
    const { POST } = await import('@/app/api/operator/calendar/block/route');
    const res = await POST(call('POST', { tourId: Number(tourId), startDate: '2028-01-01', endDate: '2028-12-31', reason: 'Межсезонье' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { blockedDates: number } }).data.blockedDates).toBe(366);
    // Проверка владения и одна запись — не 366 запросов в пул на 20 соединений.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    spy.mockRestore();

    const year = (await rows()).filter((r) => r.date.startsWith('2028-'));
    expect(year).toHaveLength(366);
    expect(year.every((r) => r.is_cancelled && r.reason === 'Межсезонье')).toBe(true);
  });

  it('блокировка закрывает уже открытую дату, повторное открытие — открывает её снова', async () => {
    const { POST } = await import('@/app/api/operator/calendar/block/route');
    const res = await POST(call('POST', { tourId: Number(tourId), startDate: '2027-07-02', endDate: '2027-07-02' }));
    expect(res.status).toBe(200);
    expect((await rows()).find((r) => r.date === '2027-07-02')).toMatchObject({ is_cancelled: true, reason: 'Заблокировано оператором', available_slots: 6 });

    const { addAvailability } = await import('@/lib/api/operator-tours');
    await addAvailability(BigInt(tourId), [{ date: '2027-07-02', available_slots: 4 }], true, operatorId);
    expect((await rows()).find((r) => r.date === '2027-07-02')).toMatchObject({ is_cancelled: false, reason: null, available_slots: 4 });
  });

  it('снятие блокировки: дата с местами открыта снова, дата без мест — убрана, как до блокировки', async () => {
    const { addAvailability } = await import('@/lib/api/operator-tours');
    await addAvailability(BigInt(tourId), [{ date: '2028-03-10', available_slots: 5 }], true, operatorId);
    const { POST, DELETE } = await import('@/app/api/operator/calendar/block/route');
    await POST(call('POST', { tourId: Number(tourId), startDate: '2028-03-10', endDate: '2028-03-10' }));
    expect((await rows()).find((r) => r.date === '2028-03-10')).toMatchObject({ is_cancelled: true, available_slots: 5 });

    const res = await DELETE(call('DELETE', { tourId: Number(tourId), startDate: '2028-03-01', endDate: '2028-03-31' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { unblocked: number } }).data.unblocked).toBe(31);
    const march = (await rows()).filter((r) => r.date.startsWith('2028-03-'));
    expect(march).toEqual([{ date: '2028-03-10', available_slots: 5, price: null, is_cancelled: false, reason: null }]);
  });

  it('открытая дата без мест в базу не пишется (CHECK slots_valid после 1307)', async () => {
    await expect(pool.query(
      `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled) VALUES ($1, '2029-01-01', 0, FALSE)`,
      [tourId],
    )).rejects.toMatchObject({ code: '23514' });
  });
});
