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
      return { rows: [{ id: 'trip-1', user_id: 'u1', inserted: sql.includes('INSERT INTO user_trips') }] };
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

/**
 * Значение колонки в записи поездки — по самому SQL, а не по номеру
 * параметра: правка пишет только присланные поля (lib/trips/trip-write), и
 * номера у них плавают. Колонки в SQL нет — undefined.
 */
function paramOf(call: { sql: string; params: unknown[] }, column: string): unknown {
  const ins = /INSERT INTO user_trips \(([^)]+)\)\s*VALUES \(([^)]+)\)/.exec(call.sql);
  if (ins) {
    const cols = ins[1]!.split(',').map((x) => x.trim());
    const at = cols.indexOf(column);
    if (at < 0) return undefined;
    const n = Number(/\$(\d+)/.exec(ins[2]!.split(',')[at]!)![1]);
    return call.params[n - 1];
  }
  const m = new RegExp(`\\b${column} = \\$(\\d+)`).exec(call.sql);
  return m ? call.params[Number(m[1]) - 1] : undefined;
}
const insertCall = () => dbCalls.find((c) => c.sql.includes('INSERT INTO user_trips'))!;
const updateCall = () => dbCalls.find((c) => c.sql.includes('UPDATE user_trips'))!;
const req = (body: unknown) => ({
  json: async () => body,
  cookies: { get: () => undefined },
}) as unknown as Parameters<typeof createTrip>[0];
const ctx = { params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000001' }) };
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
    // 10 000 × 2 + 30 000 за группу = 50 000, без множителей (решение владельца
    // 11.11, #3199 E12). Вертолёт в выборе транспорта первого дня (25 000 из
    // константы) в смету не входит.
    expect(text(est)).toContain('Итого на группу50 000 ₽');
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
    expect(sd.plan.estimate.total).toEqual([50000, 50000]);
  });
});

describe('связка: запись и чтение поездки', () => {
  beforeEach(() => { dbCalls.length = 0; });

  it('обе двери — одна схема полей (lib/trips/trip-write): день с туром и состав проходят и создание, и правку', async () => {
    const PARTY = { adults: 2, children: [6], budgetTier: 'economy', tripOrigin: 'visitor' };
    await createTrip(req({ title: 'Маршрут', days: DAYS, party: PARTY }));
    expect(JSON.parse(String(paramOf(insertCall(), 'days')))[1].realTour).toMatchObject({ tourId: 't-2', priceUnit: 'per_tour' });
    expect(JSON.parse(String(paramOf(insertCall(), 'party')))).toEqual(PARTY);
    dbCalls.length = 0;
    await patchTrip(req({ days: DAYS, party: PARTY }), ctx);
    expect(JSON.parse(String(paramOf(updateCall(), 'days')))[1].realTour).toMatchObject({ tourId: 't-2', priceUnit: 'per_tour' });
    expect(JSON.parse(String(paramOf(updateCall(), 'party')))).toEqual(PARTY);
  });

  it('миграции заводят колонки, которые пишут двери', () => {
    expect(read('migrations/1193_user_trips_choices.sql')).toMatch(/ALTER TABLE user_trips ADD COLUMN IF NOT EXISTS choices JSONB/);
    expect(read('migrations/1191_user_trips_party.sql')).toMatch(/ALTER TABLE user_trips ADD COLUMN IF NOT EXISTS party JSONB/);
    const m1397 = read('migrations/1397_user_trips_needs_warnings_save_key.sql');
    for (const col of ['needs_lodging BOOLEAN', 'needs_car     BOOLEAN', 'warnings      JSONB', 'save_key      UUID']) {
      expect(m1397, col).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
  });

  it('планировщик сохраняет состав и выбранное вместе с поездкой', () => {
    const src = read('app/planner/_PlannerClient.tsx');
    expect(src).toMatch(/party: \{\s*adults: planProfile\.adults, children: planProfile\.children,/);
    expect(src).toMatch(/choices: planChoices,/);
  });

  it('страница поездки не считает смету своей формулой', () => {
    // Что смета — формула планировщика, держит рендер выше («смета на
    // группу — формулой планировщика»); здесь — запрет на свою константу.
    const src = read('app/hub/tourist/trips/[id]/_TripDetailClient.tsx');
    expect(src).not.toMatch(/TRANSPORT_PRICE/);
  });
});

describe('роуты поездки: состав и тур доходят до базы', () => {
  const PARTY = { adults: 2, children: [6], budgetTier: 'economy', tripOrigin: 'visitor' };

  beforeEach(() => { dbCalls.length = 0; });

  it('создание: состав и дни с туром — в INSERT', async () => {
    const res = await createTrip(req({ title: 'Маршрут', days: DAYS, party: PARTY }));
    expect(res.status).toBe(201);
    expect(JSON.parse(String(paramOf(insertCall(), 'party')))).toEqual(PARTY);
    expect(JSON.parse(String(paramOf(insertCall(), 'days')))[1].realTour).toMatchObject({ tourId: 't-2', priceUnit: 'per_tour' });
  });

  it('правка: новый состав — в UPDATE, без состава — прежний остаётся', async () => {
    await patchTrip(req({ party: PARTY }), ctx);
    expect(JSON.parse(String(paramOf(updateCall(), 'party')))).toEqual(PARTY);
    dbCalls.length = 0;
    await patchTrip(req({ title: 'Новое имя' }), ctx);
    expect(paramOf(updateCall(), 'party')).toBeUndefined();
    expect(paramOf(updateCall(), 'title')).toBe('Новое имя');
  });
});

// ── Шаг 3б: выбранное жильё хранится в поездке ───────────────────────────────

const CHOICES = {
  stays: [{
    zone: 'avachinsky' as const, checkIn: '2030-08-03', checkOut: '2030-08-04', nights: 1,
    accommodationId: 'acc-1', name: 'Дом у вулкана',
    price: { kind: 'priced' as const, total: 12000, rooms: 1, roomId: 'r-1', roomName: 'Двухместный', maxGuests: 2 },
  }],
};
// Снимок, сохранённый до 13.10: тогда в план брали и место в поездке
// перевозчика. Трансфер — машина целиком (владелец), и такие места больше
// нигде не показываются и не считаются, хотя в базе остались.
const LEGACY_TRANSFERS = [{
  tripId: 't1', date: '2030-08-03', from: 'Аэропорт Елизово', to: 'Паратунка', seats: 2, pricePerSeat: 1500, carrier: 'Перевозчик',
}];

describe('выбранное жильё в сохранённой поездке (#2304, шаг 3б)', () => {
  beforeEach(() => { dbCalls.length = 0; });

  it('схема: снимок выбора проходит, лишнее (и места в поездках) срезается, негодное — нет', () => {
    const parsed = TripChoicesSchema.parse({ ...CHOICES, extra: 1, transfers: LEGACY_TRANSFERS, stays: [{ ...CHOICES.stays[0], phone: '+7' }] });
    expect(parsed).toEqual(CHOICES);
    expect(TripChoicesSchema.safeParse({ stays: [{ ...CHOICES.stays[0], price: { kind: 'bogus' } }] }).success).toBe(false);
  });

  it('создание и правка: выбор — в запросе; правка без выбора прежний не трогает', async () => {
    await createTrip(req({ title: 'Маршрут', days: DAYS, choices: CHOICES }));
    expect(JSON.parse(String(paramOf(insertCall(), 'choices')))).toEqual(CHOICES);
    dbCalls.length = 0;
    await patchTrip(req({ choices: { stays: [], transfers: LEGACY_TRANSFERS } }), ctx);
    expect(JSON.parse(String(paramOf(updateCall(), 'choices')))).toEqual({ stays: [] });
    dbCalls.length = 0;
    await patchTrip(req({ title: 'Новое имя' }), ctx);
    expect(paramOf(updateCall(), 'choices')).toBeUndefined();
  });

  it('страница: блок со ссылкой на даты плана; смета и заявка — с выбранным; места старого снимка не видны', async () => {
    tripReply = { ...TRIP, arrival_date: '2030-08-03', choices: { ...CHOICES, transfers: LEGACY_TRANSFERS } };
    render(<TripDetailClient tripId="trip-1" />);
    const block = await screen.findByTestId('trip-choices');
    expect(block.querySelector('a[href^="/accommodations/acc-1?"]')?.getAttribute('href'))
      .toBe('/accommodations/acc-1?check_in=2030-08-03&check_out=2030-08-04&adults=2&children=0&room=r-1');
    expect(block.querySelector('a[href^="/transfers"]')).toBeNull();
    expect(text(block)).toContain('12 000 ₽ на группу');
    expect(text(block)).not.toMatch(/Аэропорт Елизово|за место|мест:/);
    const est = text(screen.getByTestId('price-estimate'));
    expect(est).toContain('Жильё «Дом у вулкана», 03.08–04.08');
    expect(est).not.toContain('Трансфер Аэропорт Елизово — Паратунка');
    expect(est).not.toMatch(/\d мест|за место/);

    fireEvent.click(screen.getByRole('button', { name: /Запросить подробное предложение/ }));
    fireEvent.change(screen.getByPlaceholderText('Ваше имя'), { target: { value: 'Иван Петров' } });
    fireEvent.change(screen.getByPlaceholderText('+7 900 000-00-00'), { target: { value: '+79991234567' } });
    fireEvent.click(document.getElementById('pd-consent-trip')!);
    fireEvent.click(screen.getByRole('button', { name: /Отправить заявку/ }));
    const call = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/leads');
    const plan = JSON.parse(String(call![1]!.body)).source_data.plan;
    expect(plan.lodging).toEqual([expect.objectContaining({ accommodation_id: 'acc-1', total: 12000 })]);
    expect(plan).not.toHaveProperty('transfers');
  });

  it('без выбора — блока нет', async () => {
    tripReply = TRIP;
    render(<TripDetailClient tripId="trip-1" />);
    await screen.findByTestId('price-estimate');
    expect(screen.queryByTestId('trip-choices')).toBeNull();
  });
});
