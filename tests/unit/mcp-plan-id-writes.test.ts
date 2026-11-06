/**
 * План поездки в заявках на жильё, машину под заказ и прокат (аудит
 * планировщика 07.11, M7) — через POST роута MCP, база и сервисы подменены.
 *
 * До этого `plan_id` понимали только create_lead и create_booking_request:
 * поездку «тур + жильё + машина» из плана нельзя было собрать заявками с
 * планом, а люди и даты переспрашивались у человека, хотя план их знал.
 * Теперь:
 *  - не названо — берётся из плана, и ответ это говорит;
 *  - названо и расходится с планом — остаётся названное, расхождение сказано;
 *  - план не приложился — заявка без плана, и агент это слышит;
 *  - без плана то, что было обязательным, обязательно и сейчас.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { CharterCarrier } from '@/lib/transfers/charter-format';

const PLAN = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const DRAFT = {
  id: PLAN, revision: 1, expiresAt: '2099-01-01T00:00:00.000Z',
  params: { interests: ['volcano'], arrivalDate: '2027-07-10', departureDate: '2027-07-16', adults: 2, children: [6], budgetTier: 'comfort' },
  days: [
    { day: 1, type: 'arrival', zone: 'avachinsky', title: 'Прилёт', description: '', activityType: 'arrival', priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'walking', allowedTransports: ['walking'], difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [] },
  ],
};

const h = vi.hoisted(() => ({
  loadDraft: vi.fn(),
  submitStay: vi.fn(),
  createLead: vi.fn(async (_: Record<string, unknown>) => 'lead-1' as string | null),
  carriers: vi.fn(),
}));

vi.mock('@/lib/planner/plan-drafts', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadDraft: (...a: unknown[]) => h.loadDraft(...a),
}));
vi.mock('@/lib/stay/stay-request-service', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveStayForRequest: async () => ({ kind: 'found', id: 'acc-1', name: 'Кутха' }),
  submitStayRequest: (...a: unknown[]) => h.submitStay(...a),
}));
vi.mock('@/lib/leads/create', () => ({
  createLead: (p: Record<string, unknown>) => h.createLead(p),
  createLeadDetailed: async (p: Record<string, unknown>) => { const id = await h.createLead(p); return id ? { id, created: true } : null; },
  findRecentLeadByCommentPrefix: async () => null,
}));
vi.mock('@/lib/notifications/partner-request-notify', () => ({ notifyPartnerRequestPersonally: vi.fn(async () => ({ state: 'no_channel' })) }));
vi.mock('@/lib/leads/delivery-outcome', () => ({ recordPartnerDelivery: vi.fn(async () => true) }));
vi.mock('@/lib/kuzmich/core', () => ({ executeKuzmichTool: async () => 'ok' }));
vi.mock('@/lib/transfers/charter', () => ({ loadCharterCarriers: (...a: unknown[]) => h.carriers(...a) }));
vi.mock('@/lib/rental/rental', () => ({
  loadRentalCompanies: async () => [{
    slug: 'test-prokat', name: 'Тест Прокат',
    offers: [{ title: 'Suzuki Jimny', priceRubPerDay: 5000, priceIsFrom: false, depositRub: 10000 }],
  }],
}));
const query = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...a: unknown[]) => query(...a), connect: async () => ({ query: (...a: unknown[]) => query(...a), release: () => {} }) },
}));

import { POST } from '@/app/api/mcp/route';

let ip = 0;
async function call(name: string, args: Record<string, unknown>) {
  ip += 1;
  const res = await POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.31.${Math.floor(ip / 250)}.${ip % 250}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  const r = (await res.json()).result as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: Boolean(r.isError), text: r.content[0]?.text ?? '' };
}

function carrier(): CharterCarrier {
  return {
    partnerId: 'partner-1', slug: 'shatun', name: 'Шатун', shortDescription: null, logo: null,
    vehicles: [{ kind: 'vahtovka', title: 'КамАЗ', seats: 26 }],
    destinations: [{ from: 'Петропавловск-Камчатский', to: 'Вулкан Горелый', priceRub: 75000, note: null, conditions: 'при расчёте наличными', validYear: 2026 }],
    extraDay: null, rates: [], seatClasses: [], photos: [], clips: [], legal: null, video: null,
    phone: '+79001112233', telegramHref: null, whatsappHref: null,
  } as unknown as CharterCarrier;
}

const PERSON = { name: 'Иван Петров', phone: '+79001234567', consent: true };

beforeEach(() => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  h.loadDraft.mockReset().mockResolvedValue({ kind: 'found', draft: DRAFT });
  h.submitStay.mockReset().mockResolvedValue({ ok: true, delivered: 'owner', accommodationName: 'Кутха', requestId: 'req-1' });
  h.createLead.mockClear();
  h.carriers.mockReset().mockResolvedValue([carrier()]);
  query.mockReset().mockImplementation(async (sql: string) => {
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ a: '0', b: '0', c: '0', d: '0', e: '0' }] };
    if (/INSERT INTO mcp_write_attempts/.test(sql)) return { rows: [{ id: '5' }] };
    return { rows: [] };
  });
});

describe('create_stay_request по плану', () => {
  it('даты и гости не названы — из плана; владелец видит план строкой; агенту сказано', async () => {
    const r = await call('create_stay_request', { ...PERSON, accommodation: 'Кутха', plan_id: PLAN });
    expect(r.isError).toBe(false);
    const input = h.submitStay.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).toMatchObject({ checkIn: '2027-07-10', checkOut: '2027-07-16', guests: 3 });
    expect(String(input.comment)).toContain(`[План поездки ${PLAN}: 2027-07-10 — 2027-07-16, 3 чел.]`);
    expect(r.text).toContain('Число людей взято из плана: 3.');
    expect(r.text).not.toMatch(/выходят за даты плана/);
  });

  it('названное расходится с планом — остаётся названное, расхождение сказано', async () => {
    const r = await call('create_stay_request', {
      ...PERSON, accommodation: 'Кутха', plan_id: PLAN, guests: 5, check_in: '2027-07-20', check_out: '2027-07-22',
    });
    expect(h.submitStay.mock.calls[0]?.[0]).toMatchObject({ checkIn: '2027-07-20', checkOut: '2027-07-22', guests: 5 });
    expect(r.text).toContain('В плане 3 чел., в заявке — 5: заявка на 5.');
    expect(r.text).toContain('Даты заявки (2027-07-20 — 2027-07-22) выходят за даты плана (2027-07-10 — 2027-07-16)');
  });

  it('без плана даты обязательны, как раньше: отказ называет поле', async () => {
    const r = await call('create_stay_request', { ...PERSON, accommodation: 'Кутха' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Дата заезда в формате YYYY-MM-DD/);
    expect(h.submitStay).not.toHaveBeenCalled();
  });

  it('без плана и без гостей — один гость, как раньше', async () => {
    await call('create_stay_request', { ...PERSON, accommodation: 'Кутха', check_in: '2027-07-10', check_out: '2027-07-12' });
    expect(h.submitStay.mock.calls[0]?.[0]).toMatchObject({ guests: 1, comment: null });
  });

  it('план не найден — заявка с названными датами без плана, агент это слышит', async () => {
    h.loadDraft.mockResolvedValue({ kind: 'missing' });
    const r = await call('create_stay_request', { ...PERSON, accommodation: 'Кутха', plan_id: PLAN, check_in: '2027-07-10', check_out: '2027-07-12' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`План ${PLAN} не найден`);
    expect(String((h.submitStay.mock.calls[0]?.[0] as Record<string, unknown>).comment ?? '')).not.toContain('План поездки');
  });
});

describe('request_charter по плану', () => {
  const CHARTER = { ...PERSON, destination: 'Горелый', date_from: '2027-07-12' };

  it('число людей не названо — из плана; план — в заявке менеджеру', async () => {
    const r = await call('request_charter', { ...CHARTER, plan_id: PLAN });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Число людей взято из плана: 3.');
    const lead = h.createLead.mock.calls[0]?.[0] as { source_data: Record<string, unknown> };
    expect(lead.source_data).toMatchObject({ plan_id: PLAN, passengers: 3 });
    expect(lead.source_data).toHaveProperty('plan');
  });

  it('без плана число людей обязательно: отказ называет поле', async () => {
    const r = await call('request_charter', CHARTER);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Число человек — целое число/);
    expect(h.createLead).not.toHaveBeenCalled();
  });

  it('дата выезда вне плана — сказано', async () => {
    const r = await call('request_charter', { ...CHARTER, plan_id: PLAN, passengers: 3, date_from: '2027-08-01' });
    expect(r.text).toContain('Даты заявки (2027-08-01) выходят за даты плана');
  });
});

describe('create_car_rental_request по плану', () => {
  it('даты не названы — из плана, и черновик это говорит', async () => {
    const r = await call('create_car_rental_request', { ...PERSON, consent: false, car: 'Suzuki Jimny', plan_id: PLAN });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('с 2027-07-10 по 2027-07-16');
    expect(r.text).toContain('даты — из плана');
    expect(r.text).toMatch(/заявка ещё НЕ создана/);
  });

  it('без плана даты обязательны: отказ называет поле', async () => {
    const r = await call('create_car_rental_request', { ...PERSON, consent: false, car: 'Suzuki Jimny' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Дата начала аренды в формате YYYY-MM-DD/);
  });
});
