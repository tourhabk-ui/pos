/**
 * CRM 2г-2б: календарь оператора на общем резолвере кабинета. Менеджер
 * команды работает в нём от кабинета владельца:
 *
 *   - даты и места открывает и закрывает команда;
 *   - цену на дату ставит владелец или менеджер с правом can_edit_prices;
 *     без права цена в запросе — 403, а сохранение даты цену НЕ сбрасывает
 *     (до 2г-2б upsert писал base_price_override = NULL: «сохранить места»
 *     молча меняло цену, которую поставил владелец);
 *   - выручку месяца видит только владелец: менеджеру null и money_hidden;
 *   - календарь .ics назван именем кабинета, а не того, кто его скачал;
 *   - без кабинета — 404, «не смогли проверить» — 503, а не пустой календарь.
 *
 * Та же дыра со сбросом цены была в роуте дат тура из 2г-1 — он здесь же.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const query = vi.fn();
const dbQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a), connect: vi.fn() } }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));
vi.mock('@/lib/auth/middleware', () => ({
  requireOperator: vi.fn().mockResolvedValue({
    userId: '00000000-0000-4000-8000-0000000000a1', role: 'operator', email: 'x@example.test',
  }),
}));
const getTourById = vi.fn();
const addAvailability = vi.fn();
vi.mock('@/lib/api/operator-tours', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/operator-tours')>()),
  getTourById: (...a: unknown[]) => getTourById(...a),
  addAvailability: (...a: unknown[]) => addAvailability(...a),
}));

const calendar = await import('@/app/api/operator/calendar/route');
const bulkOpen = await import('@/app/api/operator/calendar/bulk-open/route');
const block = await import('@/app/api/operator/calendar/block/route');
const ical = await import('@/app/api/operator/calendar/ical/route');
const bookingsCalendar = await import('@/app/api/hub/operator/bookings-calendar/route');
const tourAvailability = await import('@/app/api/hub/operator/tours/[id]/availability/route');

const CABINET = '00000000-0000-4000-8000-0000000000c1';

type Seat = 'owner' | 'manager' | 'manager+prices' | 'none' | 'unavailable';

/** Ответ базы: строка общего резолвера по месту вошедшего, остальное — по SQL. */
function db(seat: Seat, other: (sql: string, params: unknown[]) => unknown = () => ({ rows: [] })) {
  query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('own_partner_id')) {
      if (seat === 'unavailable') throw Object.assign(new Error('terminating'), { code: '57P01' });
      const manager = seat === 'manager' || seat === 'manager+prices';
      return { rows: [{
        own_partner_id: seat === 'owner' ? CABINET : null,
        member_partner_id: manager ? CABINET : null,
        member_id: manager ? 'm1' : null,
        can_edit_prices: seat === 'manager+prices',
        can_cancel_bookings: false,
        was_revoked: false,
      }] };
    }
    return other(sql, params);
  });
}

const json = (url: string, method: string, body: unknown) => new NextRequest(url, {
  method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
});
const upsertCall = () => query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO tour_availability'));
const ownsTour = (sql: string) => sql.includes('FROM operator_tours WHERE id = $1 AND operator_id = $2');

beforeEach(() => {
  query.mockReset();
  dbQuery.mockReset();
  getTourById.mockReset();
  addAvailability.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('календарь: дата и цена на дату', () => {
  const post = (body: Record<string, unknown>) =>
    calendar.POST(json('http://localhost/api/operator/calendar', 'POST', { tourId: 7, date: '2026-11-01', availableSlots: 6, ...body }));

  it('менеджер без права цен: цена в запросе — 403, в базу ничего', async () => {
    db('manager');
    const res = await post({ priceOverride: 9000 });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Цены меняет владелец/);
    expect(upsertCall()).toBeUndefined();
  });

  it('менеджер без права цен сохраняет места — цена даты не сбрасывается', async () => {
    db('manager', sql => ownsTour(sql) ? { rows: [{ '?column?': 1 }] } : { rows: [{ id: '1' }] });
    const res = await post({});
    expect(res.status).toBe(200);
    const [sql, params] = upsertCall()!;
    expect(sql).toMatch(/CASE WHEN \$8::boolean THEN EXCLUDED\.base_price_override\s+ELSE tour_availability\.base_price_override END/);
    expect(params[7]).toBe(false);
    // Тур сверяется с кабинетом владельца, а не с аккаунтом менеджера.
    expect(query.mock.calls.find(([s]) => ownsTour(String(s)))![1]).toEqual([7, CABINET]);
  });

  it('владелец и менеджер с правом цен ставят цену', async () => {
    for (const seat of ['owner', 'manager+prices'] as const) {
      query.mockReset();
      db(seat, sql => ownsTour(sql) ? { rows: [{ '?column?': 1 }] } : { rows: [{ id: '1' }] });
      const res = await post({ priceOverride: 9000 });
      expect(res.status, seat).toBe(200);
      const [, params] = upsertCall()!;
      expect(params[5]).toBe(9000);
      expect(params[7]).toBe(true);
    }
  });

  it('без кабинета — 404, «не смогли проверить» — 503', async () => {
    db('none');
    expect((await calendar.GET(new NextRequest('http://localhost/api/operator/calendar'))).status).toBe(404);
    db('unavailable');
    expect((await calendar.GET(new NextRequest('http://localhost/api/operator/calendar'))).status).toBe(503);
  });

  it('менеджер видит даты кабинета владельца', async () => {
    db('manager');
    const res = await calendar.GET(new NextRequest('http://localhost/api/operator/calendar?startDate=2026-11-01&endDate=2026-11-30'));
    expect(res.status).toBe(200);
    const read = query.mock.calls.find(([sql]) => String(sql).includes('FROM tour_availability ta'))!;
    expect(read[1]).toEqual([CABINET, '2026-11-01', '2026-11-30']);
  });
});

describe('массовое открытие дат', () => {
  const post = (body: Record<string, unknown>) => bulkOpen.POST(json('http://localhost/api/operator/calendar/bulk-open', 'POST', {
    tourId: 7, startDate: '2026-11-01', endDate: '2026-11-03', slots: 8, skipExisting: false, ...body,
  }));

  it('менеджер без права цен: цена — 403; без цены — открывает, цену не трогает', async () => {
    db('manager');
    expect((await post({ priceOverride: 9000 })).status).toBe(403);
    expect(upsertCall()).toBeUndefined();

    query.mockReset();
    db('manager', sql => sql.includes('FROM operator_tours WHERE id = $1') ? { rows: [{ '?column?': 1 }] } : { rows: [] });
    const res = await post({});
    expect(res.status).toBe(200);
    const [sql, params] = upsertCall()!;
    expect(sql).toMatch(/CASE WHEN \$5::boolean THEN EXCLUDED\.base_price_override\s+ELSE tour_availability\.base_price_override END/);
    expect(params[4]).toBe(false);
  });

  it('сбой базы — лог и русский текст, а не текст ошибки базы', async () => {
    db('owner', sql => {
      if (sql.includes('FROM operator_tours WHERE id = $1')) return { rows: [{ '?column?': 1 }] };
      throw Object.assign(new Error('column "base_price_override" does not exist'), { code: '42703' });
    });
    const res = await post({});
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/column|base_price_override/);
  });
});

describe('закрыть даты — работа команды', () => {
  it('менеджер закрывает даты тура кабинета', async () => {
    db('manager', sql => ownsTour(sql) ? { rows: [{ '?column?': 1 }] } : { rows: [] });
    const res = await block.POST(json('http://localhost/api/operator/calendar/block', 'POST', {
      tourId: 7, startDate: '2026-11-01', endDate: '2026-11-02', reason: 'Шторм',
    }));
    expect(res.status).toBe(200);
    expect(query.mock.calls.find(([s]) => ownsTour(String(s)))![1]).toEqual([7, CABINET]);
  });
});

describe('календарь броней: выручка — владельцу', () => {
  const booking = { id: '1', booking_status: 'confirmed', final_price: '15000', date: '2026-11-05' };
  const answer = (sql: string) => sql.includes('FROM operator_bookings b') ? { rows: [booking] } : { rows: [] };
  const get = () => bookingsCalendar.GET(new NextRequest('http://localhost/api/hub/operator/bookings-calendar?month=2026-11'));

  it('менеджеру — брони есть, выручки нет', async () => {
    db('manager', answer);
    const body = await (await get()).json();
    expect(body.summary.total).toBe(1);
    expect(body.summary.revenue).toBeNull();
    expect(body.money_hidden).toBe(true);
  });

  it('владельцу — выручка месяца', async () => {
    db('owner', answer);
    const body = await (await get()).json();
    expect(body.summary.revenue).toBe(15000);
    expect(body.money_hidden).toBe(false);
  });
});

describe('календарь .ics', () => {
  it('назван именем кабинета, брони — кабинета', async () => {
    db('manager', (sql, params) => {
      if (sql.includes('FROM partners WHERE id = $1')) return { rows: [{ name: 'Вулкан Тур' }] };
      if (sql.includes('FROM operator_bookings b')) {
        expect(params[0]).toBe(CABINET);
        return { rows: [] };
      }
      return { rows: [] };
    });
    const res = await ical.GET(new NextRequest('http://localhost/api/operator/calendar/ical'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('X-WR-CALNAME:Туры — Вулкан Тур');
    expect(query.mock.calls.find(([s]) => String(s).includes('FROM partners WHERE id = $1'))![1]).toEqual([CABINET]);
  });
});

describe('даты тура (роут 2г-1): та же дыра со сбросом цены', () => {
  const post = (dates: unknown[]) => tourAvailability.POST(
    json('http://localhost/api/hub/operator/tours/7/availability', 'POST', { dates }),
    { params: Promise.resolve({ id: '7' }) },
  );

  it('менеджер без права цен: цена — 403; без цены — даты без права ставить цену', async () => {
    db('manager');
    getTourById.mockResolvedValue({ operator_id: CABINET });
    expect((await post([{ date: '2026-11-01', available_slots: 5, price_override: 9000 }])).status).toBe(403);
    expect(addAvailability).not.toHaveBeenCalled();

    expect((await post([{ date: '2026-11-01', available_slots: 5 }])).status).toBe(201);
    expect(addAvailability).toHaveBeenCalledWith(7n, [{ date: '2026-11-01', available_slots: 5 }], false);
  });

  it('upsert без права оставляет цену даты', async () => {
    const real = await vi.importActual<typeof import('@/lib/api/operator-tours')>('@/lib/api/operator-tours');
    dbQuery.mockResolvedValue({ rows: [] });
    await real.addAvailability(7n, [{ date: '2026-11-01', available_slots: 5 }], false);
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/base_price_override = CASE WHEN \$5::boolean THEN \$4 ELSE tour_availability\.base_price_override END/);
    expect(params[4]).toBe(false);
  });
});
