/**
 * Сторож: сохранённая поездка считает смету той же формулой и шлёт план
 * целиком (#2304, шаг 2).
 *
 * До 09.10 схема дня в /api/trips молча отбрасывала тур, цену и род дня
 * (Zod срезает незнакомые ключи), состава группы в поездке не было, и
 * страница «Моих поездок» считала свою смету: ориентир дня плюс цена
 * транспорта из константы (джип 3 000, вертолёт 25 000 ₽) без ночей.
 * Теперь поездка хранит тур и состав (миграция 1191), страница считает
 * lib/planner/estimate, а для старой поездки говорит, что не считает.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';

vi.mock('@/components/auth/Protected', () => ({
  Protected: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

// Роуты поездки — на подменённой базе: проверяется, что состав доходит до
// параметров запроса, а не только то, что SQL его упоминает.
const dbCalls: Array<{ sql: string; params: unknown[] }> = [];
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      dbCalls.push({ sql, params });
      return { rows: [{ id: 'trip-1', user_id: 'u1' }] };
    }),
  },
}));
vi.mock('@/lib/auth/middleware', () => ({ requireAuth: async () => ({ userId: 'u1' }) }));
vi.mock('@/lib/mcp/handoff', () => ({ attachMcpAttribution: async () => {}, MCP_ATTRIBUTION: { cookieName: 'x' } }));

import { TripDetailClient } from '@/app/hub/tourist/trips/[id]/_TripDetailClient';
import { POST as createTrip } from '@/app/api/trips/route';
import { PATCH as patchTrip } from '@/app/api/trips/[id]/route';
import { TripChoicesSchema, TripDayPlanSchema, TripPartySchema } from '@/lib/trips/trip-schema';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');
const text = (el: Element) => (el.textContent ?? '').replace(/ /g, ' ');

const base = { zone: 'avachinsky' as const, activityType: 'volcano', coords: [53, 158] as [number, number], defaultTransport: 'walking' as const };
const DAYS = [
  { ...base, day: 1, type: 'activity' as const, title: 'Авачинский вулкан', priceFrom: 10000, priceTo: 12000, realPrice: 10000,
    realTour: { tourId: 't-1', priceUnit: 'per_person', maxParticipants: 10, lodgingIncluded: null, operatorName: 'Оператор' } },
  { ...base, day: 2, type: 'activity' as const, title: 'Сплав', priceFrom: 30000, priceTo: 36000, realPrice: 30000,
    realTour: { tourId: 't-2', priceUnit: 'per_tour', maxParticipants: 4, lodgingIncluded: null } },
];
const TRIP = {
  id: 'trip-1', title: 'Маршрут', arrival_date: '2030-08-03', departure_date: '2030-08-04',
  flight_arrival: null, flight_departure: null, places: [], activities: ['volcano'],
  transport_by_day: { '1': 'helicopter' }, created_at: '', updated_at: '',
  days: DAYS, party: { adults: 2, children: [], budgetTier: 'comfort', tripOrigin: 'local' },
};

let tripReply: unknown = TRIP;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (String(url).startsWith('/api/trips/') ? { success: true, data: tripReply } : { success: true }),
  }) as Response));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('схема поездки хранит то, что нужно смете и заявке', () => {
  it('тур, цена и род дня доходят до базы; лишнее срезается', () => {
    const parsed = TripDayPlanSchema.parse({ ...DAYS[0], weatherForecast: { tempMax: 10 }, realTour: { ...DAYS[0]!.realTour, operatorRating: 4.5 } });
    expect(parsed.type).toBe('activity');
    expect(parsed.realPrice).toBe(10000);
    expect(parsed.realTour).toEqual({ tourId: 't-1', priceUnit: 'per_person', maxParticipants: 10, lodgingIncluded: null, operatorName: 'Оператор' });
    expect(parsed).not.toHaveProperty('weatherForecast');
  });

  it('состав группы — в разумных границах', () => {
    expect(TripPartySchema.safeParse({ adults: 2, children: [6], budgetTier: 'comfort' }).success).toBe(true);
    expect(TripPartySchema.safeParse({ adults: 0, children: [], budgetTier: 'comfort' }).success).toBe(false);
    expect(TripPartySchema.safeParse({ adults: 2, children: [40], budgetTier: 'comfort' }).success).toBe(false);
  });
});

describe('страница сохранённой поездки', () => {
  it('смета на группу — формулой планировщика, без надбавки за транспорт', async () => {
    tripReply = TRIP;
    render(<TripDetailClient tripId="trip-1" />);
    const est = await screen.findByTestId('price-estimate');
    // 10 000 × 2 + 30 000 за группу = 50 000; верх ×1.2 = 60 000. Вертолёт
    // в выборе транспорта первого дня (25 000 из константы) в смету не входит.
    expect(text(est)).toContain('Итого на группу50 000 — 60 000 ₽');
    expect(text(document.body)).toContain('30 000 ₽ за группу');
    expect(text(document.body)).not.toContain('Ориентировочная стоимость');
  });

  it('поездка без состава — смету не выдумывает, а говорит, почему её нет', async () => {
    tripReply = { ...TRIP, party: null };
    render(<TripDetailClient tripId="trip-1" />);
    expect(await screen.findByTestId('trip-no-estimate')).toBeTruthy();
    expect(screen.queryByTestId('price-estimate')).toBeNull();
  });

  it('заявка из поездки несёт план целиком', async () => {
    tripReply = TRIP;
    render(<TripDetailClient tripId="trip-1" />);
    await screen.findByTestId('price-estimate');
    fireEvent.click(screen.getByRole('button', { name: /Запросить подробное предложение/ }));
    fireEvent.change(screen.getByPlaceholderText('Ваше имя'), { target: { value: 'Иван Петров' } });
    fireEvent.change(screen.getByPlaceholderText('+7 900 000-00-00'), { target: { value: '+79991234567' } });
    fireEvent.click(document.getElementById('pd-consent-trip')!);
    fireEvent.click(screen.getByRole('button', { name: /Отправить заявку/ }));
    const call = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/leads');
    expect(call, 'заявка не ушла').toBeDefined();
    const sd = JSON.parse(String(call![1]!.body)).source_data;
    expect(sd.source).toBe('saved_trip');
    expect(sd.plan.party).toEqual({ adults: 2, children: [] });
    expect(sd.plan.estimate.total).toEqual([50000, 60000]);
  });
});

describe('связка: запись и чтение поездки', () => {
  it('оба роута — одна схема дня и состав; чтение отдаёт состав; миграция заводит колонку', () => {
    for (const f of ['app/api/trips/route.ts', 'app/api/trips/[id]/route.ts']) {
      const src = read(f);
      expect(src, f).toMatch(/TripDayPlanSchema/);
      expect(src, f).toMatch(/TripPartySchema/);
      expect(src, f).not.toMatch(/const DayPlanSchema = z\.object/);
    }
    expect(read('app/api/trips/route.ts')).toMatch(/needs_airport_transfer, party, choices\)/);
    expect(read('app/api/trips/[id]/route.ts')).toMatch(/party\s+= COALESCE\(\$14::jsonb, party\)/);
    expect(read('app/api/trips/[id]/route.ts')).toMatch(/choices\s+= COALESCE\(\$15::jsonb, choices\)/);
    expect(read('app/api/trips/[id]/route.ts')).toMatch(/needs_airport_transfer, party, choices, created_at/);
    expect(read('migrations/1193_user_trips_choices.sql')).toMatch(/ALTER TABLE user_trips ADD COLUMN IF NOT EXISTS choices JSONB/);
    expect(read('migrations/1191_user_trips_party.sql')).toMatch(/ALTER TABLE user_trips ADD COLUMN IF NOT EXISTS party JSONB/);
  });

  it('планировщик сохраняет состав и выбранное вместе с поездкой', () => {
    const src = read('app/planner/_PlannerClient.tsx');
    expect(src).toMatch(/party: \{\s*adults: planProfile\.adults, children: planProfile\.children,/);
    expect(src).toMatch(/choices: planChoices,/);
  });

  it('страница поездки не считает смету своей формулой', () => {
    const src = read('app/hub/tourist/trips/[id]/_TripDetailClient.tsx');
    expect(src).not.toMatch(/TRANSPORT_PRICE/);
    expect(src).toMatch(/estimateGroup\(days, \{ \.\.\.trip\.party, arrivalDate: trip\.arrival_date\?\.slice\(0, 10\) \?\? null \}, trip\.choices \?\? undefined\)/);
  });
});

describe('роуты поездки: состав и тур доходят до базы', () => {
  const req = (body: unknown) => ({
    json: async () => body,
    cookies: { get: () => undefined },
  }) as unknown as Parameters<typeof createTrip>[0];
  const PARTY = { adults: 2, children: [6], budgetTier: 'economy', tripOrigin: 'visitor' };

  beforeEach(() => { dbCalls.length = 0; });

  it('создание: состав и дни с туром — в INSERT', async () => {
    const res = await createTrip(req({ title: 'Маршрут', days: DAYS, party: PARTY }));
    expect(res.status).toBe(201);
    const insert = dbCalls.find((c) => c.sql.includes('INSERT INTO user_trips'))!;
    expect(JSON.parse(String(insert.params[13]))).toEqual(PARTY);
    expect(JSON.parse(String(insert.params[6]))[1].realTour).toMatchObject({ tourId: 't-2', priceUnit: 'per_tour' });
  });

  it('правка: новый состав — в UPDATE, без состава — прежний остаётся', async () => {
    const ctx = { params: Promise.resolve({ id: 'trip-1' }) };
    await patchTrip(req({ party: PARTY }), ctx);
    const update = dbCalls.find((c) => c.sql.includes('UPDATE user_trips'))!;
    expect(JSON.parse(String(update.params[13]))).toEqual(PARTY);
    dbCalls.length = 0;
    await patchTrip(req({ title: 'Новое имя' }), ctx);
    expect(dbCalls.find((c) => c.sql.includes('UPDATE user_trips'))!.params[13]).toBeNull();
  });
});

// ── Шаг 3б: выбранные жильё и трансфер хранятся в поездке ────────────────────

const CHOICES = {
  stays: [{
    zone: 'avachinsky' as const, checkIn: '2030-08-03', checkOut: '2030-08-04', nights: 1,
    accommodationId: 'acc-1', name: 'Дом у вулкана',
    price: { kind: 'priced' as const, total: 12000, rooms: 1, roomId: 'r-1', roomName: 'Двухместный', maxGuests: 2 },
  }],
  transfers: [{
    tripId: 't1', date: '2030-08-03', from: 'Аэропорт Елизово', to: 'Паратунка', seats: 2, pricePerSeat: 1500, carrier: 'Перевозчик',
  }],
};

describe('выбранное жильё и трансфер в сохранённой поездке (#2304, шаг 3б)', () => {
  const req = (body: unknown) => ({ json: async () => body, cookies: { get: () => undefined } }) as unknown as Parameters<typeof createTrip>[0];
  beforeEach(() => { dbCalls.length = 0; });

  it('схема: снимок выбора проходит, лишнее срезается, негодное — нет', () => {
    const parsed = TripChoicesSchema.parse({ ...CHOICES, extra: 1, stays: [{ ...CHOICES.stays[0], phone: '+7' }] });
    expect(parsed).toEqual(CHOICES);
    expect(TripChoicesSchema.safeParse({ ...CHOICES, transfers: [{ ...CHOICES.transfers[0], seats: 0 }] }).success).toBe(false);
    expect(TripChoicesSchema.safeParse({ stays: [{ ...CHOICES.stays[0], price: { kind: 'bogus' } }], transfers: [] }).success).toBe(false);
  });

  it('создание и правка: выбор — в запросе; правка без выбора прежний не трогает', async () => {
    await createTrip(req({ title: 'Маршрут', days: DAYS, choices: CHOICES }));
    const insert = dbCalls.find((c) => c.sql.includes('INSERT INTO user_trips'))!;
    expect(JSON.parse(String(insert.params[14]))).toEqual(CHOICES);
    dbCalls.length = 0;
    const ctx = { params: Promise.resolve({ id: 'trip-1' }) };
    await patchTrip(req({ choices: { stays: [], transfers: [] } }), ctx);
    expect(JSON.parse(String(dbCalls.find((c) => c.sql.includes('UPDATE user_trips'))!.params[14]))).toEqual({ stays: [], transfers: [] });
    dbCalls.length = 0;
    await patchTrip(req({ title: 'Новое имя' }), ctx);
    expect(dbCalls.find((c) => c.sql.includes('UPDATE user_trips'))!.params[14]).toBeNull();
  });

  it('страница: блок со ссылками на даты плана; смета и заявка — с выбранным', async () => {
    tripReply = { ...TRIP, arrival_date: '2030-08-03', choices: CHOICES };
    render(<TripDetailClient tripId="trip-1" />);
    const block = await screen.findByTestId('trip-choices');
    expect(block.querySelector('a[href^="/accommodations/acc-1?"]')?.getAttribute('href'))
      .toBe('/accommodations/acc-1?check_in=2030-08-03&check_out=2030-08-04&adults=2&children=0&room=r-1');
    expect(block.querySelector('a[href^="/transfers?"]')?.getAttribute('href')).toBe('/transfers?from=2030-08-03&to=2030-08-03&seats=2&trip=t1');
    expect(text(block)).toContain('12 000 ₽ на группу');
    const est = text(screen.getByTestId('price-estimate'));
    expect(est).toContain('Жильё «Дом у вулкана», 03.08–04.08');
    expect(est).toContain('Трансфер Аэропорт Елизово — Паратунка, 03.08');

    fireEvent.click(screen.getByRole('button', { name: /Запросить подробное предложение/ }));
    fireEvent.change(screen.getByPlaceholderText('Ваше имя'), { target: { value: 'Иван Петров' } });
    fireEvent.change(screen.getByPlaceholderText('+7 900 000-00-00'), { target: { value: '+79991234567' } });
    fireEvent.click(document.getElementById('pd-consent-trip')!);
    fireEvent.click(screen.getByRole('button', { name: /Отправить заявку/ }));
    const call = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/leads');
    const plan = JSON.parse(String(call![1]!.body)).source_data.plan;
    expect(plan.lodging).toEqual([expect.objectContaining({ accommodation_id: 'acc-1', total: 12000 })]);
    expect(plan.transfers).toEqual([expect.objectContaining({ trip_id: 't1', price_per_seat: 1500 })]);
  });

  it('без выбора — блока нет', async () => {
    tripReply = TRIP;
    render(<TripDetailClient tripId="trip-1" />);
    await screen.findByTestId('price-estimate');
    expect(screen.queryByTestId('trip-choices')).toBeNull();
  });
});
