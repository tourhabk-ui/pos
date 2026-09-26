/**
 * tests/unit/stay-availability.test.ts
 *
 * Одна формула занятости жилья для всех дверей (lib/stay/availability.ts,
 * аудит гостя 26.09). До этого дня четыре двери считали по-разному:
 * - каталог: фильтр по датам был написан, но check_in/check_out не
 *   передавались в разбор — поиск по датам не работал вовсе;
 * - blocked-dates: одна бронь закрывала ВЕСЬ объект (5 номеров, 1 бронь —
 *   для гостя «всё занято»);
 * - availability: `total_rooms || 10` — выдуманная десятка, и
 *   `parseFloat(null)` = NaN вместо «цены нет»;
 * - число владельца на дату (accommodation_availability.available_rooms)
 *   хранилось и не читалось никем; блоки уровня номера публичная
 *   доступность не видела (book их соблюдал — каталог обещал то, что бронь
 *   отклоняла);
 * - заявка pending держала номер вечно и ничего не стоила — ими можно было
 *   закрыть весь фонд.
 *
 * Семантика SQL проверена на настоящем PostgreSQL (BEGIN/ROLLBACK, отчёт
 * пакета B 26.09); здесь держится, что двери зовут одну формулу и что её
 * правила не расползлись.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

import {
  roomNightsSql, holdsRoomSql, firstUnsellableNight,
  PENDING_HOLD_HOURS, PENDING_HOLD_INTERVAL_SQL, MAX_HOLDING_PENDING_PER_PROPERTY,
} from '@/lib/stay/availability';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...a: unknown[]) => queryMock(...a),
  transaction: async (fn: (c: { query: (...a: unknown[]) => unknown }) => unknown) =>
    fn({ query: (...a: unknown[]) => queryMock(...a) }),
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'guest-1', role: 'tourist' }),
}));
vi.mock('@/lib/notifications/email-service', () => ({
  emailService: { sendEmail: vi.fn().mockResolvedValue({ success: true }) },
}));
vi.mock('@/lib/notifications/stay-booking', () => ({
  notifyNewStayBooking: vi.fn(),
  logStayFailure: vi.fn(),
  STAY_PAY_ON_SITE: 'Оплата — владельцу при заселении, после подтверждения брони',
}));

import { GET as getAvailability } from '@/app/api/accommodations/[id]/availability/route';
import { GET as getBlockedDates } from '@/app/api/accommodations/[id]/blocked-dates/route';
import { GET as getCatalog } from '@/app/api/accommodations/route';
import { POST as postBooking } from '@/app/api/accommodations/[id]/book/route';

const ACC_ID = '33333333-3333-4333-8333-333333333333';
const ROOM_ID = '55555555-5555-4555-8555-555555555555';
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const get = (url: string) => new Request(url) as unknown as NextRequest;
const params = { params: Promise.resolve({ id: ACC_ID }) };

beforeEach(() => {
  queryMock.mockReset();
});

describe('формула ночи', () => {
  const sql = roomNightsSql({ accommodation: '$1::uuid', start: '$2::date', endExclusive: '$3::date' });

  it('читает число владельца на дату — уровня номера и объекта', () => {
    expect(sql).toContain('COALESCE(ar.available_rooms, r.available_rooms)');
    expect(sql).toContain('ao.available_rooms - ob.booked');
  });

  it('закрыто — блок объекта ИЛИ номера', () => {
    expect(sql).toContain('(COALESCE(ao.is_blocked, false) OR COALESCE(ar.is_blocked, false)) AS blocked');
  });

  it('заявка держит номер только срок удержания; срок в SQL совпадает с числом', () => {
    expect(PENDING_HOLD_INTERVAL_SQL).toBe(`INTERVAL '${PENDING_HOLD_HOURS} hours'`);
    const holds = holdsRoomSql('b');
    expect(holds).toContain("b.status IN ('confirmed', 'completed')");
    expect(holds).toContain(`b.status = 'pending' AND b.created_at > NOW() - ${PENDING_HOLD_INTERVAL_SQL}`);
    expect(sql).not.toContain("NOT IN ('cancelled')");
  });

  it('занятость — по ночам полуинтервала [заезд, выезд)', () => {
    expect(sql).toContain('generate_series($2::date, $3::date - 1');
    expect(sql).toContain('b.check_in_date <= d.night::date AND b.check_out_date > d.night::date');
  });

  it('первая непродаваемая ночь: блок и «мест нет» различаются', () => {
    expect(firstUnsellableNight([
      { night: '2099-08-02', blocked: false, free_units: 0 },
      { night: '2099-08-01', blocked: false, free_units: 1 },
    ])).toEqual({ night: '2099-08-02', reason: 'full' });
    expect(firstUnsellableNight([{ night: '2099-08-01', blocked: true, free_units: 3 }]))
      .toEqual({ night: '2099-08-01', reason: 'blocked' });
    expect(firstUnsellableNight([{ night: '2099-08-01', blocked: false, free_units: 1 }])).toBeNull();
  });
});

describe('все двери зовут одну формулу', () => {
  for (const f of [
    'app/api/accommodations/[id]/book/route.ts',
    'app/api/accommodations/[id]/availability/route.ts',
    'app/api/accommodations/[id]/blocked-dates/route.ts',
    'app/api/accommodations/route.ts',
    'app/api/stay/bookings/[id]/route.ts',
  ]) {
    it(f, () => {
      expect(read(f)).toContain('roomNightsSql(');
    });
  }

  it('выдуманной десятки номеров нет', () => {
    const code = read('app/api/accommodations/[id]/availability/route.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\|\|\s*10\b/);
  });
});

describe('GET /availability', () => {
  function mock(rows: unknown[], stock: string | null = '5') {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('WITH rn AS')) return Promise.resolve({ rows });
      if (sql.includes('SUM(available_rooms)')) return Promise.resolve({ rows: [{ stock }] });
      if (sql.includes('FROM accommodations')) return Promise.resolve({ rows: [{ id: ACC_ID, name: 'Дом', is_active: true }] });
      throw new Error('unexpected SQL: ' + sql);
    });
  }

  it('пять номеров, один занят → свободно четыре, цена из номеров, фонд — сумма номеров', async () => {
    mock([{ date: '2099-08-01', rooms_left: 4, all_blocked: false, min_price: '4500', past: false }]);
    const res = await getAvailability(get(`http://l/api/accommodations/${ACC_ID}/availability?checkIn=2099-08-01&checkOut=2099-08-02`), params);
    const body = await res.json();
    expect(body.data.available).toBe(true);
    expect(body.data.availability[0]).toMatchObject({ roomsLeft: 4, price: 4500 });
    expect(body.data.totalRooms).toBe(5);
  });

  it('цены нет → null, а не NaN; номеров нет → totalRooms null, не 10', async () => {
    mock([{ date: '2099-08-01', rooms_left: 1, all_blocked: false, min_price: null, past: false }], null);
    const res = await getAvailability(get(`http://l/api/accommodations/${ACC_ID}/availability?checkIn=2099-08-01&checkOut=2099-08-02`), params);
    const body = await res.json();
    expect(body.data.availability[0].price).toBeNull();
    expect(body.data.totalRooms).toBeNull();
  });

  it('у объекта нет номеров — «продавать нечего», а не «всё свободно»', async () => {
    mock([]);
    const res = await getAvailability(get(`http://l/api/accommodations/${ACC_ID}/availability?checkIn=2099-08-01&checkOut=2099-08-02`), params);
    const body = await res.json();
    expect(body.data.available).toBe(false);
    expect(body.data.reason).toMatch(/нет номеров/);
  });

  it('roomId уходит в формулу — доступность конкретного номера', async () => {
    mock([{ date: '2099-08-01', rooms_left: 0, all_blocked: true, min_price: '3000', past: false }]);
    const res = await getAvailability(get(`http://l/api/accommodations/${ACC_ID}/availability?checkIn=2099-08-01&checkOut=2099-08-02&roomId=${ROOM_ID}`), params);
    const body = await res.json();
    expect(body.data.available).toBe(false);
    expect(body.data.availability[0].reason).toMatch(/закрыл продажу/);
    const call = queryMock.mock.calls.find(([s]) => String(s).includes('WITH rn AS'))!;
    expect(String(call[0])).toContain('AND r.id = $4::uuid');
    expect(call[1]).toEqual([ACC_ID, '2099-08-01', '2099-08-02', ROOM_ID]);
  });

  it('невалидный id → 400, в базу не ходим', async () => {
    const res = await getAvailability(get(`http://l/x?checkIn=2099-08-01&checkOut=2099-08-02`), { params: Promise.resolve({ id: 'x' }) });
    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('GET /blocked-dates', () => {
  it('закрыта дата, только если продать нечего по всем номерам; окно включает endDate', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('WITH rn AS')) return Promise.resolve({ rows: [{ date: '2099-08-02' }] });
      if (sql.includes('FROM accommodations')) return Promise.resolve({ rows: [{ id: ACC_ID, is_active: true }] });
      throw new Error('unexpected SQL: ' + sql);
    });
    const res = await getBlockedDates(get(`http://l/x?startDate=2099-08-01&endDate=2099-08-05`), params);
    const body = await res.json();
    expect(body.data.blockedDates).toEqual(['2099-08-02']);
    const sql = String(queryMock.mock.calls.find(([s]) => String(s).includes('WITH rn AS'))![0]);
    expect(sql).toContain('($3::date + 1)');
    expect(sql).toMatch(/HAVING GREATEST\(0, LEAST\(\s*SUM\(CASE WHEN rn\.blocked THEN 0 ELSE rn\.free_units END\)/);
    // одна бронь больше не закрывает объект: EXISTS по любой брони объекта ушёл
    expect(sql).not.toContain('ab.accommodation_id = $3');
  });
});

describe('GET /api/accommodations — даты доходят до фильтра', () => {
  it('check_in/check_out → условие формулы и параметры запроса', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('COUNT(*) as total')) return Promise.resolve({ rows: [{ total: '0' }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await getCatalog(get('http://l/api/accommodations?check_in=2099-08-01&check_out=2099-08-03'));
    expect(res.status).toBe(200);
    const [countSql, countParams] = queryMock.mock.calls[0];
    expect(String(countSql)).toContain('HAVING bool_and(NOT rn.blocked AND rn.free_units > 0)');
    // массив параметров общий с основным запросом (туда потом дописываются
    // limit/offset) — сверяем начало
    expect((countParams as unknown[]).slice(0, 2)).toEqual(['2099-08-01', '2099-08-03']);
  });

  it('одна дата без второй → 400', async () => {
    const res = await getCatalog(get('http://l/api/accommodations?check_in=2099-08-01'));
    expect(res.status).toBe(400);
  });
});

describe('POST /book — заявки не занимают фонд без меры', () => {
  function mockBook(holding: number, nights: unknown[]) {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] });
      if (sql.includes('AS holding')) return Promise.resolve({ rows: [{ holding }] });
      if (sql.includes('CROSS JOIN generate_series')) return Promise.resolve({ rows: nights });
      if (sql.includes('FROM accommodation_rooms r')) {
        return Promise.resolve({ rows: [{
          id: ROOM_ID, accommodation_id: ACC_ID, name: 'Люкс', max_guests: 4,
          available_rooms: 2, price_per_night: '9000', accommodation_name: 'Дом', is_active: true,
        }] });
      }
      if (sql.includes('FROM accommodation_availability')) return Promise.resolve({ rows: [] });
      if (sql.includes('INSERT INTO accommodation_bookings')) return Promise.resolve({ rows: [{ id: 'b-1' }] });
      return Promise.resolve({ rows: [] });
    });
  }
  const book = () => postBooking(new Request(`http://l/api/accommodations/${ACC_ID}/book`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId: ROOM_ID, checkInDate: '2099-08-01', checkOutDate: '2099-08-03', adults: 1 }),
  }) as unknown as NextRequest, params);
  const inserted = () => queryMock.mock.calls.some(([s]) => String(s).includes('INSERT INTO accommodation_bookings'));
  const free = [{ night: '2099-08-01', blocked: false, free_units: 1 }, { night: '2099-08-02', blocked: false, free_units: 1 }];

  it(`${MAX_HOLDING_PENDING_PER_PROPERTY} висящих заявки на объект → 429, новой нет`, async () => {
    mockBook(MAX_HOLDING_PENDING_PER_PROPERTY, free);
    const res = await book();
    expect(res.status).toBe(429);
    expect(inserted()).toBe(false);
  });

  it('счёт заявок — только держащие номер (моложе срока удержания)', async () => {
    mockBook(0, free);
    await book();
    const call = queryMock.mock.calls.find(([s]) => String(s).includes('AS holding'))!;
    expect(String(call[0])).toContain(`b.created_at > NOW() - ${PENDING_HOLD_INTERVAL_SQL}`);
    expect(call[1]).toEqual(['guest-1', ACC_ID]);
  });

  it('ночь без свободного номера → 409 с датой, новой брони нет', async () => {
    mockBook(0, [{ night: '2099-08-01', blocked: false, free_units: 1 }, { night: '2099-08-02', blocked: false, free_units: 0 }]);
    const res = await book();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/02\.08\.2099/);
    expect(inserted()).toBe(false);
  });

  it('блокировка — по объекту, тот же ключ, что у подтверждения', async () => {
    mockBook(0, free);
    const res = await book();
    expect(res.status).toBe(200);
    const lock = queryMock.mock.calls.find(([s]) => String(s).includes('pg_advisory_xact_lock'))!;
    expect(lock[1]).toEqual([ACC_ID]);
  });
});
