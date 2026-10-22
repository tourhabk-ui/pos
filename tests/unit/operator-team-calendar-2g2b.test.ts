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
// Запись дат идёт своей транзакцией (lib/tours/availability-open.ts): клиент
// пула делегирует в тот же query, и его SQL судится так же.
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...a: unknown[]) => query(...a),
    connect: async () => ({ query: (...a: unknown[]) => query(...a), release: () => undefined }),
  },
}));
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

/**
 * Ответы общей записи дат: тур кабинета, у каждой даты нет строки и броней,
 * upsert пишет по строке на дату. Что запись делает на настоящей базе —
 * tests/integration/tour-dates-open.pg.test.ts; здесь судится, с каким правом
 * цены и от чьего кабинета её зовут роуты.
 */
function datesWrite(sql: string, params: unknown[]): unknown {
  if (ownsTour(sql)) {
    return { rows: [{ title: 'Тур', max_participants: 10, is_published: true, season_start: null, season_end: null,
      duration_type: null, multi_day_count: null, duration_hours: null }] };
  }
  if (sql.includes('FROM unnest($2::date[]) AS d(date)')) {
    return { rows: (params[1] as string[]).map((date) => ({
      date, has_row: false, deleted: false, available_slots: null, is_cancelled: null, cancellation_reason: null, taken: 0,
    })) };
  }
  if (sql.includes('INSERT INTO tour_availability')) return { rows: [], rowCount: (params[1] as string[]).length };
  return { rows: [] };
}

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
    db('manager', datesWrite);
    const res = await post({});
    expect(res.status).toBe(200);
    const [sql, params] = upsertCall()!;
    expect(sql).toMatch(/CASE WHEN \$5::boolean THEN EXCLUDED\.base_price_override\s+ELSE tour_availability\.base_price_override END/);
    expect(params[4]).toBe(false);
    // Тур сверяется с кабинетом владельца, а не с аккаунтом менеджера, — тем же
    // запросом, что берёт блокировку тура.
    expect(query.mock.calls.find(([s]) => ownsTour(String(s)))![1]).toEqual(['7', CABINET]);
    expect((await res.json()).data).toMatchObject({ opened: 3, updated: 0, skipped: 0, refused: [], total: 3 });
  });

  it('кабинет как раньше открывает закрытую дату снова и прошлое не проверяет; ниже записанных — отказ с числом', async () => {
    const state: Record<string, Record<string, unknown>> = {
      '2020-01-01': { has_row: true, deleted: false, available_slots: 0, is_cancelled: true, cancellation_reason: 'Шторм', taken: 0 },
      '2020-01-02': { has_row: false, deleted: false, available_slots: null, is_cancelled: null, cancellation_reason: null, taken: 9 },
      '2020-01-03': { has_row: false, deleted: false, available_slots: null, is_cancelled: null, cancellation_reason: null, taken: 0 },
    };
    db('owner', (sql, params) => sql.includes('FROM unnest($2::date[]) AS d(date)')
      ? { rows: (params[1] as string[]).map((date) => ({ date, ...state[date] })) }
      : datesWrite(sql, params));
    const res = await post({ startDate: '2020-01-01', endDate: '2020-01-03' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ opened: 2, reopened: 1, updated: 0, skipped: 0, refused: [{ date: '2020-01-02', taken: 9 }], total: 3 });
    expect(body.message).toMatch(/не открыто 1: уже записано больше мест/);
    // В базу ушли только разрешённые даты.
    expect(upsertCall()![1][1]).toEqual(['2020-01-01', '2020-01-03']);
  });

  it('сбой базы — лог и русский текст, а не текст ошибки базы', async () => {
    db('owner', (sql, params) => {
      if (sql.includes('INSERT INTO tour_availability')) {
        throw Object.assign(new Error('column "base_price_override" does not exist'), { code: '42703' });
      }
      return datesWrite(sql, params);
    });
    const res = await post({});
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/column|base_price_override/);
    // Отказ — откат транзакции, а не половина записанного.
    expect(query.mock.calls.map(([s]) => s)).toContain('ROLLBACK');
    expect(query.mock.calls.map(([s]) => s)).not.toContain('COMMIT');
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

  const written = (date: string) => ({
    ok: true, tour: { title: 'Тур', maxParticipants: 10, isPublished: true },
    perDate: [{ date, result: 'opened' }], written: 1,
  });

  it('менеджер без права цен: цена — 403; без цены — даты без права ставить цену, от кабинета владельца', async () => {
    db('manager');
    addAvailability.mockResolvedValue(written('2026-11-01'));
    expect((await post([{ date: '2026-11-01', available_slots: 5, price_override: 9000 }])).status).toBe(403);
    expect(addAvailability).not.toHaveBeenCalled();

    expect((await post([{ date: '2026-11-01', available_slots: 5 }])).status).toBe(201);
    expect(addAvailability).toHaveBeenCalledWith(7n, [{ date: '2026-11-01', available_slots: 5 }], false, CABINET);
  });

  it('места ниже записанных — 409 с числом записанных, а не «добавлено»; тура нет — 404', async () => {
    db('owner');
    addAvailability.mockResolvedValue({
      ok: true, tour: { title: 'Тур', maxParticipants: 10, isPublished: true },
      perDate: [{ date: '2026-11-01', result: 'refused_booked', taken: 9 }], written: 0,
    });
    const res = await post([{ date: '2026-11-01', available_slots: 8 }]);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/уже записано 9/);
    expect(body.refused).toEqual([{ date: '2026-11-01', taken: 9 }]);

    addAvailability.mockResolvedValue({ ok: false, reason: 'tour_not_found' });
    expect((await post([{ date: '2026-11-01', available_slots: 8 }])).status).toBe(404);
    addAvailability.mockResolvedValue({ ok: false, reason: 'failed', sqlstate: '57P01' });
    expect((await post([{ date: '2026-11-01', available_slots: 8 }])).status).toBe(500);
  });

  it('upsert без права оставляет цену даты; тур сверяется с кабинетом', async () => {
    const real = await vi.importActual<typeof import('@/lib/api/operator-tours')>('@/lib/api/operator-tours');
    db('manager', datesWrite);
    const outcome = await real.addAvailability(7n, [{ date: '2026-11-01', available_slots: 5 }], false, CABINET);
    expect(outcome).toMatchObject({ ok: true, written: 1, perDate: [{ date: '2026-11-01', result: 'opened' }] });
    const [sql, params] = upsertCall()!;
    // Цена даты без права не трогается: условие на флаге права. Поведение на
    // настоящем PostgreSQL — tests/integration/tour-dates-open.pg.test.ts и
    // tests/integration/tour-availability-batch.pg.test.ts.
    expect(sql).toMatch(/base_price_override = CASE WHEN \$5::boolean THEN EXCLUDED\.base_price_override ELSE tour_availability\.base_price_override END/);
    expect(params[4]).toBe(false);
    expect(query.mock.calls.find(([s]) => ownsTour(String(s)))![1]).toEqual(['7', CABINET]);
  });
});
