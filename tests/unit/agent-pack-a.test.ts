/**
 * tests/unit/agent-pack-a.test.ts — «как агент продаёт» (решение владельца 26.09).
 *
 * Агент продаёт двумя путями, и оба заводят ОБЫЧНУЮ бронь оператора через
 * reserveBooking (календарь, места, одна транзакция):
 *   (а) турист бронирует сам по ссылке агента — код ссылки разрешается в
 *       транзакции брони и пишет referral_link_id + agent_user_id;
 *   (б) агент оформляет бронь за СВОЕГО клиента — created_via='agent',
 *       agent_user_id = агент.
 * Платит турист — после подтверждения оператором; до него карта не
 * списывается ни на одной двери. Комиссию здесь не выдумывает никто:
 * ставку назначает владелец. Продавать может только одобренный агент.
 *
 * Сторож держит связку целиком: производитель (reserve), обе двери, гейт
 * одобрения и отсутствие выдуманных чисел.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const h = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  poolQuery: vi.fn(),
  requireAgent: vi.fn(),
  reserve: { real: true },
}));

vi.mock('@/lib/database', () => ({
  transaction: (cb: (c: { query: (...a: unknown[]) => unknown }) => unknown) =>
    cb({ query: (...a: unknown[]) => h.clientQuery(...a) }),
  query: (...a: unknown[]) => h.poolQuery(...a),
}));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...a: unknown[]) => h.poolQuery(...a) },
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireAgent: (...a: unknown[]) => h.requireAgent(...a),
}));
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/notifications/operator-booking', () => ({
  notifyNewBooking: vi.fn().mockResolvedValue({ state: 'no_channel' }),
}));

import { reserveBooking } from '@/lib/bookings/reserve';
import { requireApprovedAgent, AGENT_NOT_APPROVED_MESSAGE } from '@/lib/auth/agent-approval';
import { POST as agentBookingPOST, GET as agentBookingGET } from '@/app/api/agent/bookings/route';
import { GET as agentToursGET } from '@/app/api/agent/tours/route';

const LINK_ID = '99999999-9999-4999-8999-999999999999';
const LINK_OWNER = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';

function insertCall(): [string, unknown[]] {
  const call = h.clientQuery.mock.calls.find(([s]) => String(s).includes('INSERT INTO operator_bookings'));
  expect(call, 'INSERT в operator_bookings не вызван').toBeTruthy();
  return call as [string, unknown[]];
}

/** Значение колонки INSERT по имени, а не по позиции. */
function inserted(column: string): unknown {
  const [sql, params] = insertCall();
  const cols = /INSERT INTO operator_bookings\s*\(([^)]*)\)/i.exec(sql)![1]!.split(',').map(s => s.trim());
  const vals = /VALUES\s*\(([^)]*)\)/i.exec(sql)![1]!.split(',').map(s => s.trim());
  const at = cols.indexOf(column);
  expect(at, `колонки ${column} нет в INSERT`).toBeGreaterThanOrEqual(0);
  return params[Number(/^\$(\d+)/.exec(vals[at]!)![1]) - 1];
}

function mockReserveDb(link: { id: string; agent_id: string } | null) {
  h.clientQuery.mockImplementation((sql: string) => {
    const s = String(sql);
    if (s.includes('FROM operator_tours')) return Promise.resolve({ rows: [{
      operator_id: 'op-1', title: 'Тур', base_price: '10000', max_participants: 10,
      multi_day_count: null, duration_hours: 6, price_unit: 'per_person',
    }] });
    if (s.includes('generate_series')) return Promise.resolve({ rows: [{ date: '2099-07-01', occupied: '0', available_slots: null, is_cancelled: null }] });
    if (s.includes('FROM agent_referral_links')) return Promise.resolve({ rows: link ? [link] : [] });
    if (s.includes('INSERT INTO operator_bookings')) return Promise.resolve({ rows: [{ id: 501, access_token: 'tok-1' }] });
    throw new Error('unexpected SQL: ' + s);
  });
}

const BASE = {
  tourId: 7, touristName: 'Иван', touristPhone: '+79990000000', participants: 2,
  date: '2099-07-01', createdVia: 'website',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.poolQuery.mockResolvedValue({ rows: [] });
  h.requireAgent.mockResolvedValue({ userId: AGENT, email: 'a@t.ru', role: 'agent' });
});

/* ─── 1. Путь (а): код ссылки → чья продажа ─────────────────────────────── */

describe('reserveBooking: код агентской ссылки', () => {
  it('активный код → referral_link_id и agent_user_id владельца ссылки, событие после коммита', async () => {
    mockReserveDb({ id: LINK_ID, agent_id: LINK_OWNER });
    const r = await reserveBooking({ ...BASE, referralCode: 'kh-agt-abc123' });

    const lookup = h.clientQuery.mock.calls.find(([s]) => String(s).includes('FROM agent_referral_links'))!;
    expect(lookup[1]).toEqual(['KH-AGT-ABC123']);
    expect(String(lookup[0])).toMatch(/is_active = true/);
    expect(String(lookup[0])).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/);
    expect(inserted('referral_link_id')).toBe(LINK_ID);
    expect(inserted('agent_user_id')).toBe(LINK_OWNER);
    expect(r.agentUserId).toBe(LINK_OWNER);

    // Журнал и счётчик — через pool (после транзакции), не внутри неё.
    const pooled = h.poolQuery.mock.calls.map(([s]) => String(s));
    expect(pooled.some(s => s.includes('INSERT INTO agent_referral_events') && s.includes("'booking'"))).toBe(true);
    expect(pooled.some(s => s.includes('conversions = COALESCE(conversions, 0) + 1'))).toBe(true);
  });

  it('плохой код — бронь всё равно заводится, без атрибуции, причина в логе', async () => {
    mockReserveDb(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await reserveBooking({ ...BASE, referralCode: 'KH-AGT-000000' });
    expect(r.bookingId).toBe(501);
    expect(inserted('referral_link_id')).toBeNull();
    expect(inserted('agent_user_id')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('KH-AGT-000000'));
    expect(h.poolQuery.mock.calls.some(([s]) => String(s).includes('agent_referral_events'))).toBe(false);
    warn.mockRestore();
  });

  it('без кода — ссылку не ищем вовсе', async () => {
    mockReserveDb(null);
    await reserveBooking({ ...BASE });
    expect(h.clientQuery.mock.calls.some(([s]) => String(s).includes('agent_referral_links'))).toBe(false);
    expect(inserted('agent_user_id')).toBeNull();
  });

  it('отказ журнала ссылки не валит бронь и пишется в лог с SQLSTATE', async () => {
    mockReserveDb({ id: LINK_ID, agent_id: LINK_OWNER });
    h.poolQuery.mockRejectedValue(Object.assign(new Error('boom'), { code: '40001' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await reserveBooking({ ...BASE, referralCode: 'KH-AGT-ABC123' });
    expect(r.bookingId).toBe(501);
    expect(err.mock.calls.some(c => String(c[0]).includes('SQLSTATE 40001'))).toBe(true);
    err.mockRestore();
  });

  it('бронь за клиента сильнее кода в памяти: agent_user_id = сам агент', async () => {
    mockReserveDb({ id: LINK_ID, agent_id: LINK_OWNER });
    await reserveBooking({ ...BASE, createdVia: 'agent', agentUserId: AGENT, referralCode: 'KH-AGT-ABC123' });
    expect(inserted('agent_user_id')).toBe(AGENT);
    expect(inserted('referral_link_id')).toBeNull();
    expect(h.clientQuery.mock.calls.some(([s]) => String(s).includes('agent_referral_links'))).toBe(false);
  });
});

describe('главная дверь брони несёт код ссылки', () => {
  it('форма карточки тура шлёт referral_code из памяти ссылки', () => {
    const form = read('components/marketplace/BookingFormClient.tsx');
    expect(form).toMatch(/agentReferralForBooking\(/);
    expect(form).toMatch(/referral_code: referralCode/);
  });

  it('/api/hub/bookings/create принимает код и передаёт его в reserveBooking', () => {
    const route = read('app/api/hub/bookings/create/route.ts');
    expect(route).toMatch(/referral_code:\s*z\.string\(\)/);
    expect(route).toMatch(/referralCode:\s*data\.referral_code/);
  });
});

/* ─── 2. Без списания до подтверждения ─────────────────────────────────── */

describe('модалка брони не списывает деньги до подтверждения оператором', () => {
  const modal = read('components/booking/TourPaymentModal.tsx');

  it('/api/bookings/tour удалён — своей вставки брони и PENDING-платежа больше нет', () => {
    expect(existsSync(join(ROOT, 'app/api/bookings/tour/route.ts'))).toBe(false);
  });

  it('модалка бронирует общей формой и не открывает платёжный виджет', () => {
    expect(modal).toMatch(/<BookingFormClient/);
    expect(modal).not.toMatch(/widget\.charge|CloudPayments\(\)|cloudpayments\.js/);
    expect(modal).not.toMatch(/fetch\(['"`]\/api\/bookings\/tour/);
  });
});

/* ─── 3. Путь (б): бронь агента за клиента ─────────────────────────────── */

function agentReq(body: unknown): NextRequest {
  return new Request('http://localhost/api/agent/bookings', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe('POST /api/agent/bookings', () => {
  beforeEach(() => {
    // Агент одобрен: гейт спрашивает partners.profile_status.
    h.poolQuery.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes('FROM partners') && s.includes("category = 'agent'")) return Promise.resolve({ rows: [{ profile_status: 'approved' }] });
      if (s.includes('FROM agent_clients')) return Promise.resolve({ rows: [{ name: 'Пётр Клиентов', phone: '8 (900) 111-22-33', email: null }] });
      return Promise.resolve({ rows: [] });
    });
  });

  it('заводит обычную бронь через reserveBooking: created_via=agent, agent_user_id=агент, ПД из карточки клиента', async () => {
    mockReserveDb(null);
    const res = await agentBookingPOST(agentReq({ clientId: CLIENT, tourId: 7, tourDate: '2099-07-01', guestsCount: 2 }));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { touristLink: string } };
    expect(body.data.touristLink).toMatch(/\/booking-success\/501\?t=tok-1$/);

    const clientLookup = h.poolQuery.mock.calls.find(([s]) => String(s).includes('FROM agent_clients'))!;
    expect(String(clientLookup[0])).toMatch(/agent_id = \$2/);
    expect(clientLookup[1]).toEqual([CLIENT, AGENT]);

    expect(inserted('created_via')).toBe('agent');
    expect(inserted('agent_user_id')).toBe(AGENT);
    expect(inserted('user_id')).toBeNull();
    expect(inserted('tourist_name')).toBe('Пётр Клиентов');
    expect(inserted('tourist_phone')).toBe('+79001112233');
    expect(inserted('booking_status')).toBe('new');
  });

  it('чужой клиент — 404, бронь не заводится', async () => {
    h.poolQuery.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes('FROM partners')) return Promise.resolve({ rows: [{ profile_status: 'approved' }] });
      return Promise.resolve({ rows: [] });   // agent_clients: не его
    });
    const res = await agentBookingPOST(agentReq({ clientId: CLIENT, tourId: 7, tourDate: '2099-07-01', guestsCount: 1 }));
    expect(res.status).toBe(404);
    expect(h.clientQuery).not.toHaveBeenCalled();
  });

  it('не одобренный агент — 403, ни клиента, ни брони', async () => {
    h.poolQuery.mockImplementation((sql: string) =>
      Promise.resolve({ rows: String(sql).includes('FROM partners') ? [{ profile_status: 'pending' }] : [] }));
    const res = await agentBookingPOST(agentReq({ clientId: CLIENT, tourId: 7, tourDate: '2099-07-01', guestsCount: 1 }));
    expect(res.status).toBe(403);
    expect(h.poolQuery.mock.calls.some(([s]) => String(s).includes('agent_clients'))).toBe(false);
    expect(h.clientQuery).not.toHaveBeenCalled();
  });

  it('не пишет agent_bookings и не выдумывает строку комиссии', () => {
    const src = read('app/api/agent/bookings/route.ts');
    expect(src).not.toMatch(/INSERT\s+INTO\s+agent_bookings/i);
    expect(src).not.toMatch(/INSERT\s+INTO\s+agent_commissions/i);
    expect(src).toMatch(/reserveBooking\(/);
    expect(src).not.toMatch(/promo_codes/);
  });

  it('GET отдаёт только свои продажи из operator_bookings', async () => {
    h.poolQuery.mockResolvedValue({ rows: [] });
    const res = await agentBookingGET(new Request('http://localhost/api/agent/bookings') as unknown as NextRequest);
    expect(res.status).toBe(200);
    const call = h.poolQuery.mock.calls.find(([s]) => String(s).includes('FROM operator_bookings'))!;
    expect(String(call[0])).toMatch(/ob\.agent_user_id = \$1/);
    expect(call[1]![0]).toBe(AGENT);
    expect(String(call[0])).not.toMatch(/agent_bookings/);
  });
});

/* ─── 4. Гейт одобрения ─────────────────────────────────────────────────── */

describe('requireApprovedAgent', () => {
  const r = new Request('http://localhost/x') as unknown as NextRequest;

  it('одобренный — пропуск, не одобренный — 403 с объяснением', async () => {
    h.poolQuery.mockResolvedValueOnce({ rows: [{ profile_status: 'approved' }] });
    expect(await requireApprovedAgent(r)).not.toBeInstanceOf(NextResponse);

    h.poolQuery.mockResolvedValueOnce({ rows: [] });
    const denied = await requireApprovedAgent(r);
    expect(denied).toBeInstanceOf(NextResponse);
    expect((denied as NextResponse).status).toBe(403);
    expect(((await (denied as NextResponse).json()) as { error: string }).error).toBe(AGENT_NOT_APPROVED_MESSAGE);
  });

  it('база не ответила — 503 и SQLSTATE в логе, а не «одобрен»', async () => {
    h.poolQuery.mockRejectedValueOnce(Object.assign(new Error('down'), { code: '57P01' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await requireApprovedAgent(r);
    expect((res as NextResponse).status).toBe(503);
    expect(err.mock.calls.some(c => String(c[0]).includes('SQLSTATE 57P01'))).toBe(true);
    err.mockRestore();
  });

  it('администратор проходит без запроса к partners', async () => {
    h.requireAgent.mockResolvedValueOnce({ userId: 'adm', email: 'x', role: 'admin' });
    expect(await requireApprovedAgent(r)).not.toBeInstanceOf(NextResponse);
    expect(h.poolQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['app/api/agent/bookings/route.ts', 'POST'],
    ['app/api/agent/clients/route.ts', 'POST'],
    ['app/api/agent/clients/[id]/route.ts', 'PUT'],
    ['app/api/hub/agent/referral/route.ts', 'POST'],
  ])('%s %s — за гейтом одобрения', (file, method) => {
    const src = read(file);
    const body = src.slice(src.indexOf(`export async function ${method}(`));
    expect(body.slice(0, 400)).toMatch(/await requireApprovedAgent\(/);
  });
});

/* ─── 5. Никаких выдуманных чисел ──────────────────────────────────────── */

describe('комиссию агента не выдумывает никто', () => {
  it.each([
    'app/api/agent/find-tours/route.ts',
    'app/api/agent/tours/route.ts',
    'app/api/agent/bookings/route.ts',
    'app/hub/agent/find/_FindToursClient.tsx',
    'app/hub/agent/bookings/_AgentBookingsPageClient.tsx',
  ])('%s: нет «× 0.10» и agent_commission', (file) => {
    const src = read(file);
    expect(src).not.toMatch(/\*\s*0?\.10?\b/);
    expect(src).not.toMatch(/\bagent_commission\b/);
    expect(src).not.toMatch(/agentCommissionRate\s*=\s*\d/);
  });

  it('GET /api/agent/tours отдаёт commission: null и единицу цены', async () => {
    h.poolQuery.mockResolvedValue({ rows: [{
      id: '7', title: 'Тур', description: null, activity_type: null, duration_hours: '6',
      multi_day_count: null, base_price: '30000', price_unit: 'per_tour', max_participants: 6,
      season_start: null, season_end: null, operator_name: 'Оп',
    }] });
    const res = await agentToursGET(new Request('http://localhost/api/agent/tours') as unknown as NextRequest);
    const body = await res.json() as { data: { tours: Array<{ commission: unknown; priceUnit: string }> } };
    expect(body.data.tours[0]!.commission).toBeNull();
    expect(body.data.tours[0]!.priceUnit).toBe('per_tour');
  });
});

/* ─── 6. Мёртвое убрано ─────────────────────────────────────────────────── */

describe('ваучеры и план агента удалены', () => {
  it('файлов нет', () => {
    for (const p of ['app/api/agent/vouchers', 'app/hub/agent/vouchers', 'app/api/agent/plan']) {
      expect(existsSync(join(ROOT, p)), p).toBe(false);
    }
  });

  it('никто не читает таблицу vouchers и не ссылается на страницу', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const rel = join(dir, name);
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(name)) {
          const s = read(rel);
          if (/(FROM|INTO|JOIN)\s+vouchers\b/i.test(s) || s.includes('/hub/agent/vouchers') || s.includes('/api/agent/plan')) hits.push(rel);
        }
      }
    };
    walk('app'); walk('components'); walk('lib');
    expect(hits).toEqual([]);
  });
});

describe('клик по ссылке считается в одном месте', () => {
  it('/api/tours/[id]/price больше не трогает agent_referral_links', () => {
    const src = read('app/api/tours/[id]/price/route.ts');
    expect(src).not.toMatch(/agent_referral_links|agent_referral_events/);
    expect(src).not.toMatch(/catch\s*\(\s*\)\s*=>\s*\{\s*\}/);
  });

  it('/r/[code] считает клик и сам', () => {
    expect(read('app/r/[code]/route.ts')).toMatch(/clicks = COALESCE\(clicks, 0\) \+ 1/);
  });
});

/* ─── 7. Клиенты агента: без клиента бронь за клиента не завести ─────────── */

describe('клиенты агента', () => {
  it('POST без статуса пишет prospect (а не NULL поверх NOT NULL), почта необязательна', async () => {
    const { POST } = await import('@/app/api/agent/clients/route');
    h.poolQuery.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes('FROM partners')) return Promise.resolve({ rows: [{ profile_status: 'approved' }] });
      if (s.includes('INSERT INTO agent_clients')) return Promise.resolve({ rows: [{ id: CLIENT, created_at: 'now' }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await POST(new Request('http://localhost/api/agent/clients', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Анна', phone: '+7 900 000-00-01' }),
    }) as unknown as NextRequest);
    expect(res.status).toBe(201);
    const ins = h.poolQuery.mock.calls.find(([s]) => String(s).includes('INSERT INTO agent_clients'))!;
    const params = ins[1] as unknown[];
    expect(params).toContain('prospect');
    expect(params).not.toContain(undefined);
    expect(params[0]).toBe(AGENT);
  });

  it('GET не парсит jsonb-теги строкой: массив остаётся массивом', async () => {
    const { GET } = await import('@/app/api/agent/clients/route');
    h.poolQuery.mockResolvedValue({ rows: [{
      id: CLIENT, name: 'Анна', email: null, phone: '+79000000001', company: null, status: 'prospect',
      notes: null, tags: ['vip'], source: 'direct', created_at: 'x', updated_at: 'x',
      bookings: 0, paid_total: '0', last_booking: null,
    }] });
    const res = await GET(new Request('http://localhost/api/agent/clients') as unknown as NextRequest);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { clients: Array<{ tags: string[] }> } };
    expect(body.data.clients[0]!.tags).toEqual(['vip']);
    expect(read('app/api/agent/clients/route.ts')).not.toMatch(/JSON\.parse\(/);
  });
});
