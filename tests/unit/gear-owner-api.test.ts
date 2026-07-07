/**
 * tests/unit/gear-owner-api.test.ts
 *
 * Owner-API аренды снаряжения (кабинет gear-партнёра, карта функционала):
 * - PUT /api/gear/items/[id] — чужая позиция невидима (404), свой апдейт
 *   пересчитывает available_quantity при смене quantity;
 * - DELETE /api/gear/items/[id] — мягкая деактивация, не физическое удаление;
 * - PATCH /api/gear/rentals/[id] — переходы статусов по жизненному циклу,
 *   невалидный переход → 422, чужая аренда → 404, инвентарные эффекты;
 * - GET /api/gear/rentals — join по gear_items (таблицы `gear` не существует);
 * - getGearStats — только реально существующие колонки (total_price,
 *   без total_amount/payment_status/gear_reviews).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
const clientQueryMock = vi.fn();

vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  transaction: (cb: (client: { query: (...args: unknown[]) => unknown }) => unknown) =>
    cb({ query: (...args: unknown[]) => clientQueryMock(...args) }),
}));

const requireAuthMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}));

import { PUT as putItem, DELETE as deleteItem } from '@/app/api/gear/items/[id]/route';
import { PATCH as patchRental } from '@/app/api/gear/rentals/[id]/route';
import { GET as getRentals, POST as postRental } from '@/app/api/gear/rentals/route';
import { getGearStats } from '@/lib/auth/gear-helpers';

const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const RENTAL_ID = '22222222-2222-4222-8222-222222222222';

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  queryMock.mockReset();
  clientQueryMock.mockReset();
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue({ userId: 'user-1', email: 'p@x.ru', role: 'gear' });
});

describe('PUT /api/gear/items/[id]', () => {
  it('чужая позиция → 404, UPDATE не выполняется', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM gear_items gi')) return Promise.resolve({ rows: [] }); // ownership
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await putItem(
      jsonReq(`http://localhost/api/gear/items/${ITEM_ID}`, 'PUT', { name: 'Палатка' }),
      routeParams(ITEM_ID)
    );

    expect(res.status).toBe(404);
    const updateCalls = queryMock.mock.calls.filter(([sql]) => String(sql).includes('UPDATE gear_items'));
    expect(updateCalls).toHaveLength(0);
  });

  it('свой апдейт quantity сохраняет число выданных единиц (available_quantity через GREATEST)', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM gear_items gi')) return Promise.resolve({ rows: [{ id: ITEM_ID }] });
      if (sql.includes('UPDATE gear_items')) return Promise.resolve({ rows: [{ id: ITEM_ID, quantity: 5 }] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await putItem(
      jsonReq(`http://localhost/api/gear/items/${ITEM_ID}`, 'PUT', { quantity: 5, isActive: false }),
      routeParams(ITEM_ID)
    );

    expect(res.status).toBe(200);
    const [updateSql] = queryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE gear_items'))!;
    expect(updateSql).toContain('is_active = $');
    expect(updateSql).toContain('available_quantity = GREATEST(0, $');
  });

  it('пустое тело → 400', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM gear_items gi')) return Promise.resolve({ rows: [{ id: ITEM_ID }] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await putItem(
      jsonReq(`http://localhost/api/gear/items/${ITEM_ID}`, 'PUT', {}),
      routeParams(ITEM_ID)
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/gear/items/[id]', () => {
  it('мягкая деактивация: is_active=false, не DELETE FROM', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM gear_items gi')) return Promise.resolve({ rows: [{ id: ITEM_ID }] });
      if (sql.includes('UPDATE gear_items')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await deleteItem(
      jsonReq(`http://localhost/api/gear/items/${ITEM_ID}`, 'DELETE'),
      routeParams(ITEM_ID)
    );

    expect(res.status).toBe(200);
    const [updateSql] = queryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE gear_items'))!;
    expect(updateSql).toContain('is_active = false');
    const hardDeletes = queryMock.mock.calls.filter(([sql]) => String(sql).includes('DELETE FROM'));
    expect(hardDeletes).toHaveLength(0);
  });
});

describe('PATCH /api/gear/rentals/[id]', () => {
  function mockRentalRow(status: string) {
    clientQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE')) {
        return Promise.resolve({
          rows: [{ id: RENTAL_ID, gear_id: ITEM_ID, quantity: 2, total_price: '3000', status }],
        });
      }
      if (sql.includes('UPDATE gear_rentals')) return Promise.resolve({ rows: [{ id: RENTAL_ID }] });
      if (sql.includes('UPDATE gear_items')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });
  }

  it('чужая аренда → 404 (ownership через gear_items.partner_id)', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM gear_rentals gr')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await patchRental(
      jsonReq(`http://localhost/api/gear/rentals/${RENTAL_ID}`, 'PATCH', { status: 'confirmed' }),
      routeParams(RENTAL_ID)
    );
    expect(res.status).toBe(404);

    const [ownershipSql] = queryMock.mock.calls.find(([sql]) => String(sql).includes('FROM gear_rentals gr'))!;
    expect(ownershipSql).toContain('JOIN gear_items gi');
  });

  it('pending → confirmed: валидный переход, 200', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM gear_rentals gr')) return Promise.resolve({ rows: [{ id: RENTAL_ID }] });
      throw new Error('unexpected SQL: ' + sql);
    });
    mockRentalRow('pending');

    const res = await patchRental(
      jsonReq(`http://localhost/api/gear/rentals/${RENTAL_ID}`, 'PATCH', { status: 'confirmed' }),
      routeParams(RENTAL_ID)
    );
    expect(res.status).toBe(200);
  });

  it('completed → active: терминальный статус, 422', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM gear_rentals gr')) return Promise.resolve({ rows: [{ id: RENTAL_ID }] });
      throw new Error('unexpected SQL: ' + sql);
    });
    mockRentalRow('completed');

    const res = await patchRental(
      jsonReq(`http://localhost/api/gear/rentals/${RENTAL_ID}`, 'PATCH', { status: 'active' }),
      routeParams(RENTAL_ID)
    );
    expect(res.status).toBe(422);
    const rentalUpdates = clientQueryMock.mock.calls.filter(([sql]) => String(sql).includes('UPDATE gear_rentals'));
    expect(rentalUpdates).toHaveLength(0);
  });

  it('confirmed → active: инвентарь уменьшается, rental_count растёт', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM gear_rentals gr')) return Promise.resolve({ rows: [{ id: RENTAL_ID }] });
      throw new Error('unexpected SQL: ' + sql);
    });
    mockRentalRow('confirmed');

    const res = await patchRental(
      jsonReq(`http://localhost/api/gear/rentals/${RENTAL_ID}`, 'PATCH', { status: 'active' }),
      routeParams(RENTAL_ID)
    );
    expect(res.status).toBe(200);

    const [itemsSql] = clientQueryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE gear_items'))!;
    expect(itemsSql).toContain('available_quantity - $1');
    expect(itemsSql).toContain('rental_count + 1');
  });

  it('active → completed: инвентарь возвращается, выручка растёт', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM gear_rentals gr')) return Promise.resolve({ rows: [{ id: RENTAL_ID }] });
      throw new Error('unexpected SQL: ' + sql);
    });
    mockRentalRow('active');

    const res = await patchRental(
      jsonReq(`http://localhost/api/gear/rentals/${RENTAL_ID}`, 'PATCH', { status: 'completed' }),
      routeParams(RENTAL_ID)
    );
    expect(res.status).toBe(200);

    const [itemsSql] = clientQueryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE gear_items'))!;
    expect(itemsSql).toContain('available_quantity + $1');
    expect(itemsSql).toContain('total_revenue + $2');
  });

  it('невалидный статус в теле → 400', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM gear_rentals gr')) return Promise.resolve({ rows: [{ id: RENTAL_ID }] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await patchRental(
      jsonReq(`http://localhost/api/gear/rentals/${RENTAL_ID}`, 'PATCH', { status: 'shipped' }),
      routeParams(RENTAL_ID)
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/gear/rentals', () => {
  it('листинг партнёра join-ится на gear_items (не на несуществующую gear)', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM partners')) return Promise.resolve({ rows: [{ id: 'partner-1' }] });
      if (sql.includes('FROM gear_rentals gr')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await getRentals(jsonReq('http://localhost/api/gear/rentals', 'GET'));
    expect(res.status).toBe(200);

    const [listSql] = queryMock.mock.calls.find(([sql]) => String(sql).includes('FROM gear_rentals gr'))!;
    expect(listSql).toContain('JOIN gear_items g ON gr.gear_id = g.id');
    expect(listSql).toContain('g.partner_id = $1');
  });
});

describe('POST /api/gear/rentals', () => {
  it('проверка доступности читает gear_items и активность позиции', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('SELECT available_quantity')) {
        return Promise.resolve({ rows: [{ available_quantity: 3, price_per_day: '500', price_per_week: null }] });
      }
      if (sql.includes('INSERT INTO gear_rentals')) return Promise.resolve({ rows: [{ id: RENTAL_ID }] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await postRental(jsonReq('http://localhost/api/gear/rentals', 'POST', {
      gearId: ITEM_ID,
      customer: { name: 'Иван', email: 'ivan@x.ru', phone: '+79990001122' },
      rental: { startDate: '2099-08-01', endDate: '2099-08-04', quantity: 1 },
    }));
    expect(res.status).toBe(200);

    const [availSql] = queryMock.mock.calls.find(([sql]) => String(sql).includes('SELECT available_quantity'))!;
    expect(availSql).toContain('FROM gear_items');
    expect(availSql).not.toContain('FROM gear\n');
  });
});

describe('getGearStats', () => {
  it('считает только по существующим колонкам: total_price, без gear_reviews/payment_status', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM partners')) return Promise.resolve({ rows: [{ id: 'partner-1' }] });
      if (sql.includes('total_rentals')) {
        return Promise.resolve({
          rows: [{
            total_items: '3', active_items: '2', total_reviews: '4', avg_rating: '4.5',
            total_rentals: '7', active_rentals: '1', completed_rentals: '5',
            pending_rentals: '1', total_revenue: '42000',
          }],
        });
      }
      if (sql.includes('DATE_TRUNC')) return Promise.resolve({ rows: [] });
      if (sql.includes('rental_count DESC')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const stats = await getGearStats('user-1');
    expect(stats).not.toBeNull();
    expect((stats!.revenue as { total: number }).total).toBe(42000);

    const allSql = queryMock.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(allSql).not.toContain('gear_reviews');
    expect(allSql).not.toContain('total_amount');
    expect(allSql).not.toContain('payment_status');
    expect(allSql).toContain('total_price');
  });
});
