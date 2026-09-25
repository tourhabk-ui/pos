/**
 * Деньги агента на настоящем PostgreSQL (пакет B, 26.09).
 *
 * Весь SQL единственной функции денег агента (lib/payments/agent-commission.ts)
 * и обзора/статистики кабинета (lib/agent-cabinet/queries.ts) ИСПОЛНЯЕТСЯ
 * здесь на схеме baseline + всех миграций (1022 agent_user_id, 1025 ставка
 * агента, 1026 заявки и позиции) — тем же путём, что у деплоя. Мок ответил
 * бы на любой текст: прежняя заявка на выплату так и прожила, не выполнившись
 * ни разу (текстовый id в uuid).
 *
 * Правила, записанные в SQL и проверяемые здесь: нет ставки — нет суммы;
 * отменённая, неоплаченная и ещё не отпущенная (конец тура + 36 ч) продажа к
 * выплате не идёт; чужие продажи не видны; бронь не выплатить дважды; одна
 * открытая заявка на агента; смена ставки не переписывает снимок; отмена
 * после заявки блокирует отметку, после выплаты — поднимает флаг.
 *
 * Запуск ТРЕБУЕТ базы: KERNEL_PG_TEST_URL=postgresql://user:pass@host/db.
 * Без неё файл честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  AGENT_MONEY_SQL, loadAgentMoney, payableForRequest,
} from '@/lib/payments/agent-commission';
import { CANCELLED_STATUS_PARAM } from '@/lib/payments/release-eligibility';
import { DASHBOARD_SQL, STATS_SQL } from '@/lib/agent-cabinet/queries';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[agent-money.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'agent_money_test';
const FIRST_AFTER_BASELINE = 863;

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

withPg('деньги агента на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  const ids = {
    agentA: '', agentB: '', admin: '', partnerA: '', partnerB: '', operator: '', tour: '',
    b1: '', b2: '', b3: '', b4: '', b5: '', b6: '', payout1: '', payout2: '',
  };

  async function booking(agent: string, opts: { daysFromNow: number; paid: boolean; status?: string; price?: number }) {
    return (await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, booking_status,
                                      payment_status, paid_at, final_price, tourist_name, tourist_email, agent_user_id)
       VALUES ($1::bigint, CURRENT_DATE + $2::int, 1, $3, $4, $5, $6, 'Турист', $7, $8::uuid)
       RETURNING id::text`,
      [ids.tour, opts.daysFromNow, opts.status ?? 'confirmed', opts.paid ? 'paid' : 'pending',
        opts.paid ? new Date() : null, opts.price ?? 10000, `t${Math.random()}@example.com`, agent],
    )).rows[0].id;
  }

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
        WHERE (substring(name from '^[0-9]+'))::bigint >= $1
           OR substring(name from '^[0-9]+') IS NULL`,
      [FIRST_AFTER_BASELINE],
    );
    execFileSync('npx', ['tsx', join(process.cwd(), 'lib', 'database', 'migrate.ts')], { env, stdio: 'pipe' });

    const user = async (email: string, role: string) => (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $1, 'x', $2) RETURNING id`, [email, role],
    )).rows[0].id;
    const partner = async (name: string, category: string, userId: string, status: string) => (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, user_id, profile_status) VALUES ($1, $2, '{}', $3, $4) RETURNING id`,
      [name, category, userId, status],
    )).rows[0].id;

    ids.agentA = await user('agent-a@example.com', 'agent');
    ids.agentB = await user('agent-b@example.com', 'agent');
    ids.admin = await user('admin@example.com', 'admin');
    ids.partnerA = await partner('Агент А', 'agent', ids.agentA, 'approved');
    ids.partnerB = await partner('Агент Б', 'agent', ids.agentB, 'approved');
    ids.operator = await partner('Оператор', 'operator', await user('op@example.com', 'operator'), 'approved');
    ids.tour = (await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, is_active, is_published, activity_type, duration_hours)
       VALUES ($1, 'Вулкан Горелый', 10000, 10, TRUE, TRUE, 'hiking', 6) RETURNING id::text`, [ids.operator],
    )).rows[0].id;

    ids.b1 = await booking(ids.agentA, { daysFromNow: -10, paid: true });                       // к выплате
    ids.b2 = await booking(ids.agentA, { daysFromNow: -10, paid: true, status: 'cancelled' });  // отменена
    ids.b3 = await booking(ids.agentA, { daysFromNow: -10, paid: false });                      // не оплачена
    ids.b4 = await booking(ids.agentA, { daysFromNow: 5, paid: true });                         // тур впереди
    ids.b5 = await booking(ids.agentB, { daysFromNow: -10, paid: true });                       // чужая
    ids.b6 = await booking(ids.agentA, { daysFromNow: -10, paid: true, price: 12345.67 });      // срок из tour_payments
    await pool.query(
      `INSERT INTO tour_payments (booking_id, operator_id, retail_amount, net_amount, commission_amount, commission_rate,
                                  status, paid_at, release_after)
       VALUES ($1::bigint, $2, 12345.67, 11111.10, 1234.57, 10, 'HELD', NOW(), NOW() + INTERVAL '2 days')`,
      [ids.b6, ids.operator],
    );
  }, 300_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  it('ставки нет — продажи видны, сумм нет', async () => {
    const m = await loadAgentMoney(pool, ids.agentA);
    expect(m.rate).toBeNull();
    expect(m.sales).toHaveLength(5);
    expect(m.summary.payable).toBeNull();
    expect(m.summary.waiting).toBeNull();
    expect(payableForRequest(m.sales)).toEqual([]);
  });

  it('состояния: отменённая, неоплаченная, тур впереди, срок из tour_payments', async () => {
    await pool.query(AGENT_MONEY_SQL.setRate, [ids.partnerA, 10, ids.admin, 'договор от 26.09']);
    const m = await loadAgentMoney(pool, ids.agentA);
    const by = new Map(m.sales.map((s) => [s.bookingId, s]));
    expect(m.rate).toBe(10);
    expect(by.get(ids.b1)?.state).toBe('payable');
    expect(by.get(ids.b1)?.amount).toBe(1000);
    expect(by.get(ids.b2)?.state).toBe('cancelled');
    expect(by.get(ids.b3)?.state).toBe('unpaid');
    expect(by.get(ids.b4)?.state).toBe('waiting');
    // Тур давно прошёл, но release_after строки платежа ещё впереди — ждёт.
    expect(by.get(ids.b6)?.state).toBe('waiting');
    expect(by.get(ids.b6)?.amount).toBe(1234.57);
    // Чужая продажа не видна.
    expect(by.has(ids.b5)).toBe(false);
  });

  it('ставку можно назначить только агенту и не выше 30', async () => {
    const op = await pool.query(AGENT_MONEY_SQL.setRate, [ids.operator, 10, ids.admin, 'не агент вовсе']);
    expect(op.rows).toHaveLength(0);
    await expect(pool.query(AGENT_MONEY_SQL.setRate, [ids.partnerB, 31, ids.admin, 'слишком много'])).rejects.toMatchObject({ code: '23514' });
  });

  it('заявка: снимок позиций, одна открытая на агента, бронь не дважды', async () => {
    const m = await loadAgentMoney(pool, ids.agentA);
    const items = payableForRequest(m.sales);
    expect(items.map((i) => i.bookingId)).toEqual([ids.b1]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await loadAgentMoney(client, ids.agentA, true);
      expect(locked.profile?.partner_id).toBe(ids.partnerA);
      expect((await client.query(AGENT_MONEY_SQL.openPayout, [ids.agentA])).rows).toHaveLength(0);
      const p = await client.query<{ id: string }>(AGENT_MONEY_SQL.insertPayout, [ids.agentA, 1000, 'bank_transfer', null]);
      ids.payout1 = p.rows[0].id;
      await client.query(AGENT_MONEY_SQL.insertItems, [ids.payout1, ids.agentA, [ids.b1], [10000], [10], [1000]]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    expect((await pool.query(AGENT_MONEY_SQL.openPayout, [ids.agentA])).rows).toHaveLength(1);
    // Вторая открытая заявка — отказ базы.
    await expect(pool.query(AGENT_MONEY_SQL.insertPayout, [ids.agentA, 1, 'sbp', null])).rejects.toMatchObject({ code: '23505' });
    // Та же бронь во второй позиции — отказ базы, даже в чужой заявке.
    const other = await pool.query<{ id: string }>(AGENT_MONEY_SQL.insertPayout, [ids.agentB, 1000, 'sbp', null]);
    await expect(pool.query(AGENT_MONEY_SQL.insertItems, [other.rows[0].id, ids.agentB, [ids.b1], [10000], [10], [1000]]))
      .rejects.toMatchObject({ code: '23505' });

    const after = await loadAgentMoney(pool, ids.agentA);
    const b1 = after.sales.find((s) => s.bookingId === ids.b1);
    expect(b1?.state).toBe('requested');
    expect(payableForRequest(after.sales)).toEqual([]);
    expect(after.summary.requested).toBe(1000);
  });

  it('смена ставки не переписывает запрошенное', async () => {
    await pool.query(AGENT_MONEY_SQL.setRate, [ids.partnerA, 20, ids.admin, 'новый договор 27.09']);
    const m = await loadAgentMoney(pool, ids.agentA);
    const b1 = m.sales.find((s) => s.bookingId === ids.b1);
    expect(b1?.rate).toBe(10);
    expect(b1?.amount).toBe(1000);
    expect(m.sales.find((s) => s.bookingId === ids.b4)?.amount).toBe(2000);
  });

  it('отмена после заявки блокирует отметку; отказ освобождает позиции', async () => {
    await pool.query(`UPDATE operator_bookings SET booking_status = 'cancelled' WHERE id = $1::bigint`, [ids.b1]);
    const blockers = await pool.query<{ booking_id: string; voided: boolean }>(AGENT_MONEY_SQL.payoutBlockers, [ids.payout1, CANCELLED_STATUS_PARAM]);
    expect(blockers.rows.map((r) => r.booking_id)).toEqual([ids.b1]);
    expect(blockers.rows[0].voided).toBe(true);

    const flagged = (await loadAgentMoney(pool, ids.agentA)).sales.find((s) => s.bookingId === ids.b1);
    expect(flagged?.flag).toBe('cancelled_in_request');

    expect((await pool.query(AGENT_MONEY_SQL.lockPayout, [ids.payout1])).rows[0]).toMatchObject({ status: 'pending' });
    expect((await pool.query(AGENT_MONEY_SQL.reject, [ids.payout1, ids.admin, 'бронь отменена'])).rows).toHaveLength(1);
    await pool.query(AGENT_MONEY_SQL.releaseItems, [ids.payout1]);
    // Повторно не отклонить и не отметить.
    expect((await pool.query(AGENT_MONEY_SQL.markPaid, [ids.payout1, ids.admin, 'перевод №1 от 27.09'])).rows).toHaveLength(0);

    const m = await loadAgentMoney(pool, ids.agentA);
    expect(m.sales.find((s) => s.bookingId === ids.b1)?.state).toBe('cancelled');
    expect((await pool.query(AGENT_MONEY_SQL.openPayout, [ids.agentA])).rows).toHaveLength(0);
  });

  it('освобождённую бронь можно запросить снова; выплата и флаг отмены после неё', async () => {
    await pool.query(`UPDATE operator_bookings SET booking_status = 'confirmed' WHERE id = $1::bigint`, [ids.b1]);
    const m = await loadAgentMoney(pool, ids.agentA);
    const items = payableForRequest(m.sales);
    expect(items.map((i) => [i.bookingId, i.amount])).toEqual([[ids.b1, 2000]]);

    const p = await pool.query<{ id: string }>(AGENT_MONEY_SQL.insertPayout, [ids.agentA, 2000, 'sbp', 'на карту']);
    ids.payout2 = p.rows[0].id;
    await pool.query(AGENT_MONEY_SQL.insertItems, [ids.payout2, ids.agentA, [ids.b1], [10000], [20], [2000]]);
    expect((await pool.query(AGENT_MONEY_SQL.payoutBlockers, [ids.payout2, CANCELLED_STATUS_PARAM])).rows).toHaveLength(0);
    expect((await pool.query(AGENT_MONEY_SQL.markPaid, [ids.payout2, ids.admin, 'перевод №4412 от 27.09'])).rows).toHaveLength(1);

    const paid = await loadAgentMoney(pool, ids.agentA);
    expect(paid.sales.find((s) => s.bookingId === ids.b1)?.state).toBe('paid_out');
    expect(paid.summary.paidOut).toBe(2000);

    await pool.query(`UPDATE operator_bookings SET booking_status = 'cancelled' WHERE id = $1::bigint`, [ids.b1]);
    const flagged = await pool.query<{ booking_id: string }>(AGENT_MONEY_SQL.cancelledAfterPayout, [CANCELLED_STATUS_PARAM]);
    expect(flagged.rows.map((r) => r.booking_id)).toEqual([ids.b1]);
    const after = await loadAgentMoney(pool, ids.agentA);
    // Не минус: выплаченное остаётся выплаченным, но с флагом.
    expect(after.summary.paidOut).toBe(2000);
    expect(after.summary.flagged).toBe(1);
  });

  it('список администратора, агенты, заявки агента — исполняются', async () => {
    const all = await pool.query(AGENT_MONEY_SQL.adminPayouts, [null, CANCELLED_STATUS_PARAM]);
    expect(all.rows.length).toBeGreaterThanOrEqual(2);
    const paid = await pool.query<{ id: string; items: unknown[] }>(AGENT_MONEY_SQL.adminPayouts, ['paid', CANCELLED_STATUS_PARAM]);
    expect(paid.rows.map((r) => r.id)).toEqual([ids.payout2]);
    expect(paid.rows[0].items).toHaveLength(1);
    const agents = await pool.query<{ partner_id: string; rate: string | null }>(AGENT_MONEY_SQL.adminAgents);
    expect(agents.rows.find((a) => a.partner_id === ids.partnerA)?.rate).toBe('20.00');
    const mine = await pool.query<{ id: string }>(AGENT_MONEY_SQL.agentPayouts, [ids.agentA, 20]);
    expect(mine.rows.map((r) => r.id).sort()).toEqual([ids.payout1, ids.payout2].sort());
  });

  it('обзор и статистика кабинета исполняются и считают только оплаченное', async () => {
    const metrics = await pool.query<{ total_bookings: number; paid_bookings: number; paid_revenue: string }>(
      DASHBOARD_SQL.metrics, [ids.agentA, 30, CANCELLED_STATUS_PARAM],
    );
    expect(metrics.rows[0].total_bookings).toBe(5);
    // b4 и b6 оплачены и не отменены; b1 теперь отменена, b3 не оплачена.
    expect(metrics.rows[0].paid_bookings).toBe(2);
    expect(Number(metrics.rows[0].paid_revenue)).toBeCloseTo(22345.67, 2);
    const upcoming = await pool.query(DASHBOARD_SQL.upcoming, [ids.agentA, CANCELLED_STATUS_PARAM]);
    expect(upcoming.rows).toHaveLength(1);
    const retention = await pool.query<{ clients: number }>(STATS_SQL.retention, [ids.agentA, CANCELLED_STATUS_PARAM]);
    expect(retention.rows[0].clients).toBe(2);
    const top = await pool.query<{ name: string; bookings: number }>(STATS_SQL.topTours, [ids.agentA, CANCELLED_STATUS_PARAM]);
    expect(top.rows[0]).toMatchObject({ name: 'Вулкан Горелый', bookings: 2 });
  });
});
