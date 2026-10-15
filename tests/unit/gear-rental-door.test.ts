/**
 * Дверь проката (аудит 15.10, находка A13, вариант «а» по карт-бланшу).
 *
 * До 15.10 POST /api/gear/rentals называл себя публичным, а Edge пускал к
 * /api/gear анонима только с GET: гость получал голый 401, вошедший проходил,
 * и его ПД уходили прокату без согласия, называющего получателя. Пик
 * занятости и INSERT шли отдельными запросами (две заявки на последнюю
 * единицу проходили обе), заявка держала единицу бессрочно, число заявок на
 * человека не ограничивалось, «сегодня» не проверялось вовсе, а catch молчали.
 *
 * Сторож судит ВЫЗОВОМ роута на подменённой базе, которая ведёт себя как
 * база там, где это важно для правила: advisory-блокировка — настоящий
 * взаимоисключающий замок по ключу, каждый запрос уступает ход (так две
 * заявки переплетаются, как на проде), заявки живут в памяти. Семантику SQL
 * (48 часов, NULL-ы, типы) судит настоящий PostgreSQL:
 * tests/integration/booking-writers.pg.test.ts, блок «дверь проката».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

import {
  GEAR_PENDING_HOLD_HOURS, GEAR_PENDING_HOLD_INTERVAL_SQL, MAX_OPEN_GEAR_REQUESTS_PER_USER,
  holdsGearSql,
} from '@/lib/gear/availability';
import { PD_CONSENT_GEAR_VERSION, PD_CONSENT_GEAR_TEXT, consentWording } from '@/lib/legal/pd-consent';

// ── Подменённая база ──────────────────────────────────────────────────────

interface FakeRental {
  id: string; gear_id: string; user_id: string | null; quantity: number;
  status: string; start: string; end: string;
}

const db = {
  stock: 1,
  rentals: [] as FakeRental[],
  inserts: [] as unknown[][],
  failWith: null as (Error & { code?: string }) | null,
};
let seq = 0;
const lockTails = new Map<string, Promise<void>>();

/** Уступить ход: другая заявка успевает выполнить свой запрос. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function overlaps(r: FakeRental, start: string, end: string): boolean {
  return r.start < end && r.end > start;
}

async function answer(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
  await tick();
  if (db.failWith) throw db.failWith;
  if (sql.includes('FROM gear_items gi')) {
    return { rows: [{
      name: 'Палатка', quantity: db.stock, price_per_day: '500', price_per_week: null,
      price_per_month: null, insurance_cost_per_day: null, partner_id: 'partner-1',
    }] };
  }
  if (sql.includes('FROM partners')) return { rows: [] };
  if (sql.includes('open_requests')) {
    const n = db.rentals.filter((r) => r.user_id === params[0] && r.status === 'pending').length;
    return { rows: [{ open_requests: n }] };
  }
  if (sql.includes('peak_rented')) {
    const [gear, start, end, exclude] = params as string[];
    const used = db.rentals
      .filter((r) => r.gear_id === gear && r.id !== exclude && r.status !== 'cancelled' && overlaps(r, start, end))
      .reduce((s, r) => s + r.quantity, 0);
    return { rows: [{ peak_rented: String(used) }] };
  }
  if (sql.includes('INSERT INTO gear_rentals')) {
    db.inserts.push(params);
    const id = `rental-${++seq}`;
    db.rentals.push({
      id, gear_id: String(params[0]), user_id: String(params[1]), quantity: Number(params[7]),
      status: 'pending', start: String(params[5]), end: String(params[6]),
    });
    return { rows: [{ id }] };
  }
  if (sql.includes('FOR UPDATE')) {
    const r = db.rentals.find((x) => x.id === params[0]);
    return { rows: r ? [{ id: r.id, gear_id: r.gear_id, quantity: r.quantity, total_price: '1000',
      status: r.status, start_date: r.start, end_date: r.end }] : [] };
  }
  if (sql.includes('SELECT quantity FROM gear_items')) return { rows: [{ quantity: db.stock }] };
  if (sql.includes('UPDATE gear_rentals')) {
    const r = db.rentals.find((x) => x.id === params[1]);
    if (r) r.status = String(params[0]);
    return { rows: r ? [{ id: r.id, status: r.status }] : [] };
  }
  if (sql.includes('FROM gear_rentals gr')) return { rows: [{ id: params[1] }] };
  throw new Error('неожиданный SQL: ' + sql.slice(0, 80));
}

async function fakeTransaction<T>(fn: (c: { query: typeof answer }) => Promise<T>): Promise<T> {
  const releases: Array<() => void> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        await tick();
        const key = String(params[0]);
        const prev = lockTails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const mine = new Promise<void>((r) => { release = r; });
        lockTails.set(key, prev.then(() => mine));
        await prev;
        releases.push(release);
        return { rows: [] };
      }
      return answer(sql, params);
    },
  };
  try {
    return await fn(client);
  } finally {
    for (const r of releases) r();
  }
}

vi.mock('@/lib/database', () => ({
  query: (sql: string, params?: unknown[]) => answer(sql, params),
  transaction: (fn: (c: { query: typeof answer }) => Promise<unknown>) => fakeTransaction(fn),
}));

// Кто вошёл — заголовок теста; без него — гость, как отвечает настоящий requireAuth.
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: vi.fn(async (req: Request) => {
    const user = req.headers.get('x-test-user');
    if (!user) return NextResponse.json({ success: false, error: 'Требуется аутентификация' }, { status: 401 });
    return { userId: user, email: `${user}@x.ru`, role: user === 'partner' ? 'gear' : 'tourist' };
  }),
}));
vi.mock('@/lib/notifications/gear-rental', () => ({ notifyNewGearRental: vi.fn(async () => undefined) }));
vi.mock('@/lib/crm/contacts', () => ({ linkContactQuietly: vi.fn(async () => undefined) }));
vi.mock('@/lib/crm/events', () => ({
  recordSourceEventQuietly: vi.fn(async () => undefined),
  statusChangeTitle: () => 'статус',
}));
vi.mock('@/lib/auth/gear-helpers', () => ({
  getGearPartnerId: vi.fn(async () => 'partner-1'),
  verifyGearRentalOwnership: vi.fn(async () => true),
}));

import { POST } from '@/app/api/gear/rentals/route';
import { PATCH } from '@/app/api/gear/rentals/[id]/route';

const GEAR_ID = '11111111-1111-4111-8111-111111111111';

function rentalBody(over: Record<string, unknown> = {}) {
  return {
    gearId: GEAR_ID,
    customer: { name: 'Иван', email: 'ivan@x.ru', phone: '+79990001122' },
    rental: { startDate: '2099-08-01', endDate: '2099-08-04', quantity: 1 },
    pd_consent: true,
    ...over,
  };
}

function post(user: string | null, body: unknown = rentalBody()) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (user) headers['x-test-user'] = user;
  return POST(new Request('http://l/api/gear/rentals', {
    method: 'POST', headers, body: JSON.stringify(body),
  }) as unknown as NextRequest);
}

beforeEach(() => {
  db.stock = 1;
  db.rentals = [];
  db.inserts = [];
  db.failWith = null;
  lockTails.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('дверь под входом', () => {
  it('гость получает 401 до единого запроса в базу — форма по нему показывает вход', async () => {
    const res = await post(null);
    expect(res.status).toBe(401);
    expect(db.inserts).toHaveLength(0);
  });

  it('заявка знает, кто её отправил', async () => {
    const res = await post('u-1');
    expect(res.status).toBe(200);
    expect(db.rentals[0]?.user_id).toBe('u-1');
  });
});

describe('согласие на передачу прокату', () => {
  it('без галочки — 400, заявки нет', async () => {
    const { pd_consent: _omit, ...noConsent } = rentalBody();
    void _omit;
    const res = await post('u-1', noConsent);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/согласие/i);
    expect(db.inserts).toHaveLength(0);
  });

  it('согласие записано той же вставкой: время, адрес, форма, версия «прокату»', async () => {
    await post('u-1');
    const params = db.inserts[0]!;
    // Порядок — как в INSERT роута: …, comments, pd_consent_at/ip/source/version.
    const [at, ip, source, version] = params.slice(-4);
    expect(at).toBeInstanceOf(Date);
    expect(typeof ip).toBe('string');
    expect(source).toBe('gear-page');
    expect(version).toBe(PD_CONSENT_GEAR_VERSION);
  });

  it('текст согласия называет получателя, версия своя', () => {
    expect(PD_CONSENT_GEAR_TEXT).toMatch(/передачу прокату снаряжения/);
    expect(consentWording('gear')).toEqual({ text: PD_CONSENT_GEAR_TEXT, version: PD_CONSENT_GEAR_VERSION });
    const versions = (['operator', 'stay', 'carrier', 'gear'] as const).map((p) => consentWording(p).version);
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe('последняя единица — одна заявка', () => {
  it('две одновременные заявки разных людей на последнюю единицу: вторая — отказ', async () => {
    db.stock = 1;
    const [a, b] = await Promise.all([post('u-1'), post('u-2')]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(db.rentals).toHaveLength(1);
  });

  it('ключ блокировки — позиция (и человек), а не что-то общее на весь прокат', async () => {
    const res = await post('u-1');
    expect(res.status).toBe(200);
    expect([...lockTails.keys()]).toEqual(expect.arrayContaining([GEAR_ID, 'gear-user:u-1']));
  });

  it('занято — 409 с честным остатком', async () => {
    db.stock = 3;
    db.rentals.push({ id: 'x', gear_id: GEAR_ID, user_id: 'other', quantity: 2, status: 'confirmed', start: '2099-08-02', end: '2099-08-03' });
    const res = await post('u-1', rentalBody({ rental: { startDate: '2099-08-01', endDate: '2099-08-04', quantity: 2 } }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/свободно только 1 шт/);
  });
});

describe(`потолок: ${MAX_OPEN_GEAR_REQUESTS_PER_USER} открытые заявки на человека`, () => {
  it(`с ${MAX_OPEN_GEAR_REQUESTS_PER_USER} открытыми — 429, новой заявки нет; у другого человека — проходит`, async () => {
    db.stock = 10;
    for (let i = 0; i < MAX_OPEN_GEAR_REQUESTS_PER_USER; i++) {
      db.rentals.push({ id: `p${i}`, gear_id: 'another', user_id: 'u-1', quantity: 1, status: 'pending', start: '2099-07-01', end: '2099-07-02' });
    }
    const res = await post('u-1');
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain(`${GEAR_PENDING_HOLD_HOURS} часов`);
    expect(db.inserts).toHaveLength(0);

    const other = await post('u-2');
    expect(other.status).toBe(200);
  });

  it(`с ${MAX_OPEN_GEAR_REQUESTS_PER_USER - 1} открытыми — проходит`, async () => {
    db.stock = 10;
    for (let i = 0; i < MAX_OPEN_GEAR_REQUESTS_PER_USER - 1; i++) {
      db.rentals.push({ id: `p${i}`, gear_id: 'another', user_id: 'u-1', quantity: 1, status: 'pending', start: '2099-07-01', end: '2099-07-02' });
    }
    expect((await post('u-1')).status).toBe(200);
  });
});

describe(`заявка держит единицу ${GEAR_PENDING_HOLD_HOURS} часов`, () => {
  it('срок в SQL совпадает с числом, которое называют человеку', () => {
    expect(GEAR_PENDING_HOLD_INTERVAL_SQL).toBe(`INTERVAL '${GEAR_PENDING_HOLD_HOURS} hours'`);
    expect(holdsGearSql('gr')).toContain(`gr.created_at > NOW() - ${GEAR_PENDING_HOLD_INTERVAL_SQL}`);
  });

  it('алиас проверяется — в SQL не уходит чужая строка', () => {
    expect(() => holdsGearSql("gr; DROP TABLE gear_rentals --")).toThrow();
  });

  it('подтверждение заявки перепроверяет занятость: единицу уже взяли — 409, статус прежний', async () => {
    const OLD = '33333333-3333-4333-8333-333333333333';
    db.stock = 1;
    db.rentals.push(
      // Заявка старше срока: единицу за это время подтвердили другому.
      { id: OLD, gear_id: GEAR_ID, user_id: 'u-1', quantity: 1, status: 'pending', start: '2099-08-01', end: '2099-08-04' },
      { id: 'taken', gear_id: GEAR_ID, user_id: 'u-2', quantity: 1, status: 'confirmed', start: '2099-08-02', end: '2099-08-05' },
    );
    const patch = () => PATCH(
      new Request(`http://l/api/gear/rentals/${OLD}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-test-user': 'partner' },
        body: JSON.stringify({ status: 'confirmed' }),
      }) as unknown as NextRequest,
      { params: Promise.resolve({ id: OLD }) },
    );
    const res = await patch();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain(`${GEAR_PENDING_HOLD_HOURS} часов`);
    expect(db.rentals.find((r) => r.id === OLD)?.status).toBe('pending');
    expect([...lockTails.keys()]).toContain(GEAR_ID);

    // Единица освободилась — подтверждение проходит.
    db.rentals.find((r) => r.id === 'taken')!.status = 'cancelled';
    expect((await patch()).status).toBe(200);
    expect(db.rentals.find((r) => r.id === OLD)?.status).toBe('confirmed');
  });
});

describe('«сегодня» — по Камчатке', () => {
  it('в 08:00 по Камчатке вчерашний (по UTC — сегодняшний) день начала — 400; сегодняшний — проходит', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T20:00:00Z')); // Камчатка: 16.10, 08:00
    const past = await post('u-1', rentalBody({ rental: { startDate: '2026-10-15', endDate: '2026-10-17', quantity: 1 } }));
    expect(past.status).toBe(400);
    expect((await past.json()).error).toMatch(/уже прошла/);
    const today = await post('u-1', rentalBody({ rental: { startDate: '2026-10-16', endDate: '2026-10-17', quantity: 1 } }));
    expect(today.status).toBe(200);
  });

  it('несуществующая дата — 400', async () => {
    const res = await post('u-1', rentalBody({ rental: { startDate: '2099-02-30', endDate: '2099-03-02', quantity: 1 } }));
    expect(res.status).toBe(400);
  });
});

describe('отказ базы называется', () => {
  it('500 и строка лога с именем проверки и SQLSTATE', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    db.failWith = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const res = await post('u-1');
    expect(res.status).toBe(500);
    const line = spy.mock.calls.find((c) => String(c[0]).includes('[gear-rentals]'));
    expect(line, 'отказ не попал в лог').toBeDefined();
    expect(String(line![0])).toContain('создание заявки');
    expect(line![1]).toMatchObject({ code: '40P01' });
  });
});
