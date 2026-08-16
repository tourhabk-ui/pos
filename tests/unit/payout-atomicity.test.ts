/**
 * Выплата оператору не создаётся дважды (#1217).
 *
 * Было: SELECT без блокировки → INSERT выплаты → UPDATE платежей →
 * пересчёт комиссии, четырьмя отдельными запросами вне транзакции.
 * Два способа отдать деньги дважды:
 *
 *   1. Сбой между INSERT и UPDATE: выплата создана, платежи остались HELD.
 *      Админ видит «выплаты по ним нет» и запускает снова.
 *   2. Два одновременных запроса: SELECT без FOR UPDATE ничего не блокирует,
 *      оба видят одни и те же HELD-платежи и оба создают выплату.
 *
 * Уникальный индекс от второго не спасает — payment_ids это массив.
 *
 * Здесь проверяется поведение обработчика на поддельном пуле: две парал-
 * лельные выплаты по одним платежам дают ровно одну запись, а сбой в
 * середине не оставляет выплату без перевода платежей.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(process.cwd(), 'app/api/admin/finance/payouts/route.ts'),
  'utf-8',
);

/* ─── Поддельная БД: строки платежей + блокировка FOR UPDATE ─────────────── */

interface FakeRow { id: string; status: string; net_amount: string }

class FakeDb {
  payments: FakeRow[] = [];
  payouts: Array<{ ids: string[] }> = [];
  /** Держатель блокировки; вторая транзакция ждёт освобождения. */
  private lock: Promise<void> | null = null;
  /** Куда «падать» ради проверки отката. */
  failOn: string | null = null;

  async acquire(): Promise<() => void> {
    while (this.lock) await this.lock;
    let release!: () => void;
    this.lock = new Promise<void>(res => { release = () => { this.lock = null; res(); }; });
    return release;
  }
}

function makeClient(db: FakeDb) {
  let unlock: (() => void) | null = null;
  const staged: { ids: string[] } | null = null;
  void staged;
  const pending: Array<() => void> = [];

  return {
    async query(sql: string, params?: unknown[]) {
      if (db.failOn && sql.includes(db.failOn)) throw new Error('сбой посреди выплаты');

      if (sql.includes('BEGIN')) return { rows: [] };

      if (sql.includes('FOR UPDATE')) {
        unlock = await db.acquire();
        const ids = (params?.[0] as string[]) ?? [];
        const rows = db.payments.filter(p => ids.includes(p.id) && p.status === 'HELD');
        return { rows: rows.map(r => ({ id: r.id, net_amount: r.net_amount })) };
      }
      if (sql.includes('FROM partners')) return { rows: [{ payout_verified: true }] };

      if (sql.includes('INSERT INTO operator_payouts')) {
        const ids = (params?.[3] as string[]) ?? [];
        // Запись видна другим только после COMMIT.
        pending.push(() => db.payouts.push({ ids }));
        return { rows: [{ id: `payout-${db.payouts.length + pending.length}` }] };
      }
      if (sql.includes('UPDATE tour_payments')) {
        const ids = (params?.[0] as string[]) ?? [];
        pending.push(() => {
          for (const p of db.payments) if (ids.includes(p.id)) p.status = 'RELEASED';
        });
        return { rows: [] };
      }
      if (sql.includes('recalculate_commission')) return { rows: [] };

      if (sql.includes('COMMIT')) {
        pending.forEach(fn => fn());
        pending.length = 0;
        unlock?.();
        return { rows: [] };
      }
      if (sql.includes('ROLLBACK')) {
        pending.length = 0;
        unlock?.();
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() { unlock?.(); },
  };
}

const db = new FakeDb();

vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: vi.fn(async () => ({ userId: 'admin-1' })),
}));

vi.mock('@/lib/database', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  transaction: async <T>(cb: (c: unknown) => Promise<T>): Promise<T> => {
    const client = makeClient(db);
    try {
      await client.query('BEGIN');
      const r = await cb(client);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  },
}));

const { POST } = await import('@/app/api/admin/finance/payouts/route');

function req(paymentIds: string[]) {
  return new Request('http://x/api/admin/finance/payouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operatorId: '11111111-1111-4111-8111-111111111111',
      paymentIds,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
    }),
  }) as unknown as Parameters<typeof POST>[0];
}

const P1 = '22222222-2222-4222-8222-222222222222';
const P2 = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  db.payments = [
    { id: P1, status: 'HELD', net_amount: '1000.00' },
    { id: P2, status: 'HELD', net_amount: '2000.00' },
  ];
  db.payouts = [];
  db.failOn = null;
});

describe('деньги не уходят дважды', () => {
  it('два одновременных запроса по одним платежам дают одну выплату', async () => {
    const [a, b] = await Promise.all([POST(req([P1, P2])), POST(req([P1, P2]))]);
    const codes = [a.status, b.status].sort();

    expect(db.payouts).toHaveLength(1);
    expect(codes).toEqual([200, 400]); // второй честно получает отказ
    expect(db.payments.every(p => p.status === 'RELEASED')).toBe(true);
  });

  it('сбой посреди выплаты не оставляет её без перевода платежей', async () => {
    db.failOn = 'UPDATE tour_payments';
    await expect(POST(req([P1, P2]))).rejects.toThrow();

    // Ни выплаты, ни изменённых статусов: откат вернул всё как было.
    expect(db.payouts).toHaveLength(0);
    expect(db.payments.every(p => p.status === 'HELD')).toBe(true);
  });
});

describe('частичная выплата не проходит молча', () => {
  it('часть платежей уже выплачена — отказ, а не выплата за остаток', async () => {
    db.payments[1].status = 'RELEASED';
    const res = await POST(req([P1, P2]));
    const body = await res.json() as { error?: string };

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/Часть платежей недоступна/);
    expect(db.payouts).toHaveLength(0);
    // Оставшийся платёж не тронут — админ решает сам.
    expect(db.payments[0].status).toBe('HELD');
  });

  it('нет подходящих платежей вовсе — понятный отказ', async () => {
    db.payments.forEach(p => { p.status = 'RELEASED'; });
    const res = await POST(req([P1, P2]));
    expect(res.status).toBe(400);
    expect(db.payouts).toHaveLength(0);
  });
});

describe('устройство обработчика', () => {
  it('вся выплата в одной транзакции', () => {
    expect(SRC).toMatch(/await transaction\(async client =>/);
    // Отдельных запросов мимо транзакции в POST не осталось.
    const post = SRC.slice(SRC.indexOf('export async function POST'));
    expect(post).not.toMatch(/await query\(/);
  });

  it('строки платежей блокируются до любых изменений', () => {
    const post = SRC.slice(SRC.indexOf('export async function POST'));
    const lockAt = post.indexOf('FOR UPDATE');
    const insertAt = post.indexOf('INSERT INTO operator_payouts');
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(insertAt);
  });

  it('пересчёт комиссии внутри транзакции, а не после неё', () => {
    const post = SRC.slice(SRC.indexOf('export async function POST'));
    expect(post).toMatch(/client\.query\(`SELECT recalculate_commission/);
  });
});
