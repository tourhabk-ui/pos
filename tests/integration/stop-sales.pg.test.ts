/**
 * Стоп-продажи оператора (PR5) на настоящем PostgreSQL: закрываются только
 * открытые даты своего тура без записанных мест, журнал пишется, повтор не
 * двоит, «Снять стоп» открывает только свои закрытия; счёт дат витрины
 * (open-dates) закрытую дату не считает.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

vi.mock('@/lib/chat-cabinet/signed-payload', () => ({ signPayload: (p: string) => p }));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
const TEST_DB = 'stop_sales_test';

function day(n: number): string {
  return new Date(Date.now() + 12 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);
}

withPg('стоп-продажи на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  let op = '';
  let other = '';
  let tour = '';

  async function addPartner(name: string): Promise<string> {
    return (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact) VALUES ($1, 'operator', '{}'::jsonb) RETURNING id::text AS id`, [name],
    )).rows[0]!.id;
  }
  async function addTour(operatorId: string): Promise<string> {
    return (await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit, min_participants, max_participants,
                                   duration_hours, difficulty, is_active, is_published)
       VALUES ($1, 'Бухта', $2, 'hiking', 5000, 'per_person', 1, 10, 8, 'easy', true, true) RETURNING id::text AS id`,
      [operatorId, `ss-${Math.random().toString(36).slice(2, 10)}`],
    )).rows[0]!.id;
  }
  async function state(): Promise<Record<string, { c: boolean; r: string | null }>> {
    const r = await pool.query<{ d: string; c: boolean; r: string | null }>(
      `SELECT date::text AS d, is_cancelled AS c, cancellation_reason AS r FROM tour_availability WHERE operator_tour_id = $1 ORDER BY date`, [tour],
    );
    return Object.fromEntries(r.rows.map((x) => [x.d, { c: x.c, r: x.r }]));
  }

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    op = await addPartner('Оператор');
    other = await addPartner('Чужой');
    tour = await addTour(op);
    await pool.query(
      `INSERT INTO tour_availability (operator_tour_id, date, available_slots, booked_slots, is_cancelled, cancellation_reason) VALUES
         ($1, $2, 10, 0, false, NULL), ($1, $3, 10, 2, false, NULL), ($1, $4, 10, 0, true, 'Закрыто вручную'), ($1, $5, 10, 0, false, NULL)`,
      [tour, day(1), day(2), day(3), day(20)],
    );
  }, 120_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await appPool.end().catch(() => undefined);
    await pool?.end();
    await dropTestDatabase(PG_URL, TEST_DB);
  });

  it('закрыть неделю, повтор, чужой, снять стоп', async () => {
    const { stopSalesPress, STOP_REASON } = await import('@/lib/operators/stop-sales');
    const { countTourDates } = await import('@/lib/tours/open-dates');
    const base = { userId: null, via: 'max' as const, dialog: true };

    const before = await countTourDates(Number(tour));
    const ask = (await stopSalesPress({ ...base, partnerId: op, payload: `ss:a:${tour}:7` }))!;
    expect(ask.text).toMatch(/Закроются 1 дат/);
    expect(ask.text).toMatch(/с бронями остаются открытыми/);

    expect((await stopSalesPress({ ...base, partnerId: other, payload: `ss:y:${tour}:7` }))!.text).toMatch(/среди ваших нет/);

    const done = (await stopSalesPress({ ...base, partnerId: op, payload: `ss:y:${tour}:7` }))!;
    expect(done.text).toMatch(/закрыто 1 дат/);
    let s = await state();
    expect(s[day(1)]).toEqual({ c: true, r: STOP_REASON });
    expect(s[day(2)]!.c).toBe(false); // бронь — дата остаётся
    expect(s[day(3)]).toEqual({ c: true, r: 'Закрыто вручную' });
    expect(s[day(20)]!.c).toBe(false); // вне периода
    const after = await countTourDates(Number(tour));
    expect(after!.open).toBe(before!.open - 1);

    expect((await stopSalesPress({ ...base, partnerId: op, payload: `ss:y:${tour}:7` }))!.text).toMatch(/закрывать нечего|уже закрыты/);
    const log = await pool.query(`SELECT action, dates::text[] AS dates, kept_booked::text[] AS kept, via FROM tour_stop_sales ORDER BY id`);
    expect(log.rows).toEqual([{ action: 'close', dates: [day(1)], kept: [day(2)], via: 'max' }]);

    expect((await stopSalesPress({ ...base, partnerId: op, payload: `ss:v:${tour}` }))!.text).toMatch(/снова открыто 1 дат/);
    s = await state();
    expect(s[day(1)]).toEqual({ c: false, r: null });
    expect(s[day(3)]).toEqual({ c: true, r: 'Закрыто вручную' }); // чужое закрытие не трогаем
    const log2 = await pool.query(`SELECT action FROM tour_stop_sales ORDER BY id`);
    expect(log2.rows.map((r) => r.action)).toEqual(['close', 'open']);
  });
});
