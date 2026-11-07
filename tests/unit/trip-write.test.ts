/**
 * Запись сохранённой поездки (аудит планировщика 07.11, волна 2.3–2.4: H6,
 * H7, H9, H11, H12). Правила — lib/trips/trip-write; роуты /api/trips и
 * /api/trips/[id] — на подменённой базе, SQL — тот, что уходит в неё.
 * На настоящем PostgreSQL те же запросы проверены при сдаче (описание PR).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dbCalls: Array<{ sql: string; params: unknown[] }> = [];
let failWith: (Error & { code?: string }) | null = null;
let insertedFlag = true;
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      dbCalls.push({ sql, params });
      if (failWith) throw failWith;
      return { rows: [{ id: 'trip-1', user_id: 'u1', title: 'Маршрут', inserted: insertedFlag }] };
    }),
  },
}));
vi.mock('@/lib/auth/middleware', () => ({ requireAuth: async () => ({ userId: 'u1' }) }));
const attribution = vi.fn(async () => {});
vi.mock('@/lib/mcp/handoff', () => ({ attachMcpAttribution: (...a: unknown[]) => attribution(...(a as [])), MCP_ATTRIBUTION: { cookieName: 'x' } }));

import { buildTripUpdate, UpdateTripSchema, CreateTripSchema } from '@/lib/trips/trip-write';
import { POST as createTrip, GET as listTrips } from '@/app/api/trips/route';
import { PATCH as patchTrip } from '@/app/api/trips/[id]/route';
import { TripDayPlanSchema } from '@/lib/trips/trip-schema';

const req = (body: unknown) => ({
  json: async () => body,
  cookies: { get: () => undefined },
}) as unknown as Parameters<typeof createTrip>[0];
const ID = '00000000-0000-4000-8000-000000000001';
const ctx = { params: Promise.resolve({ id: ID }) };
const KEY = '6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';

beforeEach(() => {
  dbCalls.length = 0;
  failWith = null;
  insertedFlag = true;
  attribution.mockClear();
});

describe('правка пишет только присланное; null — стереть (H9)', () => {
  it('стереть рейс и дату прилёта можно, неприсланное не трогается', () => {
    const { sets, values } = buildTripUpdate(UpdateTripSchema.parse({ flightArrival: null, arrivalDate: null, needsCar: true }), 3);
    expect(sets).toEqual(['arrival_date = $3::date', 'flight_arrival = $4', 'needs_car = $5']);
    expect(values).toEqual([null, null, true]);
  });

  it('пустая правка — пустой SET; JSONB — строкой и с приведением', () => {
    expect(buildTripUpdate(UpdateTripSchema.parse({}), 3).sets).toEqual([]);
    const { sets, values } = buildTripUpdate(UpdateTripSchema.parse({ warnings: [{ type: 'mchs', severity: 'critical', message: 'Тест' }] }), 3);
    expect(sets).toEqual(['warnings = $3::jsonb']);
    expect(JSON.parse(String(values[0]))).toEqual([{ type: 'mchs', severity: 'critical', message: 'Тест' }]);
  });

  it('колонки NOT NULL null не стирает: схема его и не пропускает', () => {
    expect(UpdateTripSchema.safeParse({ title: null }).success).toBe(false);
    expect(UpdateTripSchema.safeParse({ days: null }).success).toBe(false);
  });

  it('роут: SET только присланного, владелец — в условии, null уходит в базу', async () => {
    const res = await patchTrip(req({ flightArrival: null, needsLodging: false }), ctx);
    expect(res.status).toBe(200);
    const update = dbCalls.find((c) => c.sql.includes('UPDATE user_trips'))!;
    expect(update.sql).toMatch(/SET flight_arrival = \$3, needs_lodging = \$4\s/);
    expect(update.sql).toMatch(/WHERE id = \$1 AND user_id = \$2 AND deleted_at IS NULL/);
    expect(update.params).toEqual([ID, 'u1', null, false]);
    expect(update.sql).not.toMatch(/COALESCE/);
  });

  it('роут: чужой или удалённый id — 404, а не правка', async () => {
    const res = await patchTrip(req({ title: 'x' }), { params: Promise.resolve({ id: 'не-uuid' }) });
    expect(res.status).toBe(404);
    expect(dbCalls).toHaveLength(0);
  });
});

describe('галочки и предупреждения доходят до базы (H6, H7)', () => {
  it('день хранит свои предупреждения', () => {
    const d = TripDayPlanSchema.parse({ day: 1, zone: 'avachinsky', title: 'Вулкан', activityType: 'volcano', priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'walking', dayWarnings: ['МЧС: регистрация группы'] });
    expect(d.dayWarnings).toEqual(['МЧС: регистрация группы']);
  });

  it('создание: жильё, машина, предупреждения плана — в INSERT; не прислали — NULL «не записано»', async () => {
    await createTrip(req({ title: 'М', needsLodging: true, needsCar: false, warnings: [{ type: 'season', severity: 'important', message: 'Не сезон' }] }));
    const ins = dbCalls.find((c) => c.sql.includes('INSERT INTO user_trips'))!;
    const cols = /INSERT INTO user_trips \(([^)]+)\)/.exec(ins.sql)![1]!.split(',').map((x) => x.trim());
    const at = (c: string) => ins.params[cols.indexOf(c)];
    expect(at('needs_lodging')).toBe(true);
    expect(at('needs_car')).toBe(false);
    expect(JSON.parse(String(at('warnings')))).toEqual([{ type: 'season', severity: 'important', message: 'Не сезон' }]);
    dbCalls.length = 0;
    await createTrip(req({ title: 'М' }));
    const ins2 = dbCalls.find((c) => c.sql.includes('INSERT INTO user_trips'))!;
    expect(ins2.params[cols.indexOf('needs_lodging')]).toBeNull();
    expect(ins2.params[cols.indexOf('warnings')]).toBeNull();
  });
});

describe('повтор сохранения не плодит копий (H12)', () => {
  it('ключ уходит в INSERT, конфликт — по индексу живых поездок человека', async () => {
    await createTrip(req({ title: 'М', saveKey: KEY }));
    const ins = dbCalls.find((c) => c.sql.includes('INSERT INTO user_trips'))!;
    expect(ins.params).toContain(KEY);
    expect(ins.sql).toMatch(/ON CONFLICT \(user_id, save_key\) WHERE save_key IS NOT NULL AND deleted_at IS NULL\s+DO UPDATE SET/);
    // Цель конфликта совпадает с уникальным индексом миграции — иначе
    // PostgreSQL отвечает 42P10 на каждом сохранении.
    const mig = readFileSync(join(process.cwd(), 'migrations/1397_user_trips_needs_warnings_save_key.sql'), 'utf-8');
    expect(mig).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_user_trips_save_key\s+ON user_trips \(user_id, save_key\)\s+WHERE save_key IS NOT NULL AND deleted_at IS NULL;/);
  });

  it('при повторе пишется всё, кроме владельца и ключа', async () => {
    await createTrip(req({ title: 'М', saveKey: KEY }));
    const set = /DO UPDATE SET ([\s\S]+?)\s+RETURNING/.exec(dbCalls[0]!.sql)![1]!;
    expect(set).toMatch(/title = EXCLUDED\.title/);
    expect(set).toMatch(/days = EXCLUDED\.days/);
    expect(set).not.toMatch(/user_id = EXCLUDED/);
    expect(set).not.toMatch(/save_key = EXCLUDED/);
  });

  it('новая — 201 и событие «сохранён»; повтор — 200 и без второго события', async () => {
    const first = await createTrip(req({ title: 'М', saveKey: KEY }));
    expect(first.status).toBe(201);
    expect(attribution).toHaveBeenCalledTimes(1);
    insertedFlag = false;
    const again = await createTrip(req({ title: 'М', saveKey: KEY }));
    expect(again.status).toBe(200);
    expect(attribution).toHaveBeenCalledTimes(1);
    const body = await again.json() as { data: Record<string, unknown> };
    expect(body.data).not.toHaveProperty('inserted');
  });

  it('ключ — только UUID', () => {
    expect(CreateTripSchema.safeParse({ saveKey: 'abc' }).success).toBe(false);
  });
});

describe('отказ базы — в лог, наружу общие слова (H11)', () => {
  it.each([
    ['создание', () => createTrip(req({ title: 'М' }))],
    ['правка', () => patchTrip(req({ title: 'М' }), ctx)],
    ['список', () => listTrips(req({}))],
  ])('%s', async (_name, call) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    failWith = Object.assign(new Error('relation "user_trips" does not exist'), { code: '42P01' });
    const res = await call();
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).not.toMatch(/relation|user_trips|42P01/);
    expect(spy.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/42P01/);
    spy.mockRestore();
  });
});
