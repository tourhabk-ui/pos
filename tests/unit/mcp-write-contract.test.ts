/**
 * Договор шести заявок MCP (ревью MCP 08.11), вызовом роута:
 *
 *   - `test: true` у каждой из шести: проверки проходят, но ничего не
 *     записывается и никому не уходит — ни лида, ни запроса мест, ни заявки
 *     хозяину, ни строки ключа, ни личного сообщения партнёру. Повод: живая
 *     проверка внешним агентом — демонстрационная заявка ушла менеджеру;
 *   - пробный ключ get_request_status читает состоянием `test`;
 *   - structuredContent пишущего инструмента: ключ, страница, подписка — без
 *     регулярки по тексту;
 *   - телефон, которого не бывает (+70000000000), — отказ до записи.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { CharterCarrier } from '@/lib/transfers/charter-format';

const { createLeadMock, query, seatRequestMock, sendPdAlertMock, partnerNotifyMock, personalNotifyMock, avail } = vi.hoisted(() => ({
  createLeadMock: vi.fn(async (_: Record<string, unknown>) => 'lead-1' as string | null),
  query: vi.fn(),
  seatRequestMock: vi.fn(),
  sendPdAlertMock: vi.fn(),
  partnerNotifyMock: vi.fn(async () => ({ state: 'no_channel' })),
  personalNotifyMock: vi.fn(async () => ({ state: 'no_channel' })),
  avail: { remaining: 10, keepsSchedule: true },
}));

vi.mock('@/lib/leads/create', () => ({
  createLead: (p: Record<string, unknown>) => createLeadMock(p),
  createLeadDetailed: async (p: Record<string, unknown>) => { const id = await createLeadMock(p); return id ? { id, created: true } : null; },
  findRecentLeadByCommentPrefix: async () => null,
}));
vi.mock('@/lib/kuzmich/core', () => ({ executeKuzmichTool: async () => 'ok' }));
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => ({}),
  fetchAvailabilityForTour: async (_id: string, from: string) => [{ date: from, remaining: avail.remaining, priceOverride: null }],
}));
vi.mock('@/lib/seat-requests/service', () => ({
  createSeatRequest: (...a: unknown[]) => seatRequestMock(...a),
  statusUrl: (t: string) => `https://vedarai.ru/seat/${t}`,
  tourKeepsSchedule: async () => avail.keepsSchedule,
}));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (p: unknown) => sendPdAlertMock(p) }));
vi.mock('@/lib/notifications/partner-request-notify', () => ({ notifyPartnerRequestPersonally: (...a: unknown[]) => partnerNotifyMock(...(a as [])) }));
vi.mock('@/lib/notifications/lead-notify', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  notifyPartnerNewLeadPersonally: (...a: unknown[]) => personalNotifyMock(...(a as [])),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query, connect: async () => ({ query, release: () => {} }) } }));
vi.mock('@/lib/rental/rental', () => ({
  loadRentalCompanies: async () => [{
    slug: 'test-prokat', name: 'Тест Прокат',
    offers: [{ title: 'Suzuki Jimny', priceRubPerDay: 5000, priceIsFrom: false, depositRub: 10000 }],
  }],
}));
const line = (to: string, priceRub: number) => ({ from: 'Петропавловск-Камчатский', to, priceRub, note: null, conditions: null, validYear: 2026 });
const CARRIER: CharterCarrier = {
  partnerId: 'partner-1', slug: 'shatun', name: 'Шатун', shortDescription: null, logo: null,
  vehicles: [{ kind: 'vahtovka', title: 'КамАЗ-1', seats: 26 }],
  destinations: [line('Вулкан Авачинский', 65000)],
  extraDay: null, rates: [], seatClasses: [],
  photos: [], clips: [], legal: null, video: null,
  phone: '+79001112233', telegramHref: null, whatsappHref: null,
} as unknown as CharterCarrier;
vi.mock('@/lib/transfers/charter', () => ({ loadCharterCarriers: async () => [CARRIER] }));

import { POST } from '@/app/api/mcp/route';
import { implausiblePhone, normalizePhone } from '@/lib/mcp/normalize-phone';
import { isTestKey, issueTestKey, WRITE_OUTPUT_SCHEMA } from '@/lib/mcp/test-run';
import { PUBLIC_MCP_TOOLS, WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';

const TOUR = { id: 27, title: 'Сплав по реке Быстрая', operator_id: 'op-uuid-1', base_price: 13000, price_unit: 'person', nearest_free_date: null };
const STAY_ID = '3b2551c7-ed5c-47c8-bb93-41ca6a278c1e';
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

let ip = 0;
async function call(name: string, args: Record<string, unknown>) {
  ip += 1;
  const res = await POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.8.${Math.floor(ip / 250)}.${ip % 250}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  return (await res.json()).result as {
    isError?: boolean; content: Array<{ text: string }>;
    structuredContent?: { test: boolean; accepted: number; requests: Array<{ tool: string; outcome: string; status_key: string | null; status_page: string | null; notify: unknown }> };
  };
}

const PERSON = { name: 'Иван Петров', phone: '+79001234567', consent: true };
const DATE = inDays(30);
const ARGS: Record<string, Record<string, unknown>> = {
  create_lead: { ...PERSON, comment: 'Хотим на вулкан в августе, 4 человека, бюджет 200000 руб' },
  create_booking_request: { ...PERSON, tour: '27', date: DATE, participants: 2 },
  create_stay_request: { ...PERSON, accommodation: STAY_ID, check_in: DATE, check_out: inDays(32), guests: 2 },
  request_charter: { ...PERSON, destination: 'Вулкан Авачинский', date_from: DATE, passengers: 4 },
  create_trip_request: { ...PERSON, tour: '27', tour_date: DATE },
};

/** Всё, чем заявка доходит до человека или остаётся в базе. */
const WRITE_SQL = /INSERT INTO (leads|stay_requests|seat_requests|agent_request_keys|agent_request_notify|mcp_write_attempts|pd_consents)|UPDATE leads/i;
const writes = () => query.mock.calls.filter(([sql]) => WRITE_SQL.test(String(sql)));
const nothingSent = () => {
  expect(createLeadMock).not.toHaveBeenCalled();
  expect(seatRequestMock).not.toHaveBeenCalled();
  expect(sendPdAlertMock).not.toHaveBeenCalled();
  expect(partnerNotifyMock).not.toHaveBeenCalled();
  expect(personalNotifyMock).not.toHaveBeenCalled();
  expect(writes()).toEqual([]);
};

beforeEach(() => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  avail.remaining = 10;
  avail.keepsSchedule = true;
  for (const m of [createLeadMock, seatRequestMock, sendPdAlertMock, partnerNotifyMock, personalNotifyMock]) m.mockClear();
  sendPdAlertMock.mockResolvedValue({ delivered: true, channel: 'max', reason: 'доставлено в MAX' });
  query.mockReset().mockImplementation(async (sql: string) => {
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ a: '0', b: '0', c: '0' }] };
    if (/FROM operator_tours/.test(sql)) return { rows: [TOUR] };
    if (/AS has_site/.test(sql)) return { rows: [{ id: STAY_ID, name: 'Кутха', has_site: false, has_rooms: false, has_phone: true }] };
    return { rows: [] };
  });
});

describe('test: true — проверки как у заявки, ничего не записано и не отправлено', () => {
  for (const tool of Object.keys(ARGS)) {
    it(`${tool}: пробный ключ, ни записи, ни сообщения`, async () => {
      const r = await call(tool, { ...ARGS[tool], test: true });
      expect(r.isError, r.content[0]?.text).toBeUndefined();
      expect(r.content[0]!.text).toMatch(/test: true/);
      expect(r.content[0]!.text).toMatch(/не записан[аы]? и никому не передан|ничего не записано и никому не передано/);
      expect(r.structuredContent?.test).toBe(true);
      expect(r.structuredContent?.accepted).toBe(0);
      expect(r.structuredContent?.requests.length).toBeGreaterThan(0);
      for (const q of r.structuredContent!.requests) {
        expect(q.outcome).toBe('test');
        expect(isTestKey(q.status_key ?? '')).toBe(true);
      }
      // Сводка поездки целиком не говорит «создано» о пробе.
      if (tool === 'create_trip_request') {
        expect(r.content[0]!.text).toMatch(/\(проба, test: true\)/);
        expect(r.content[0]!.text).not.toMatch(/создано частей|: создано\./);
      }
      nothingSent();
    });
  }

  it('тур без расписания: запрос мест оператору в пробе не уходит', async () => {
    avail.remaining = 0;
    avail.keepsSchedule = false;
    const r = await call('create_booking_request', { ...ARGS.create_booking_request, test: true });
    expect(r.content[0]!.text).toMatch(/запрос мест оператору в мессенджер/);
    expect(r.structuredContent?.requests[0]?.outcome).toBe('test');
    nothingSent();
  });

  it('прокат: оба шага проходят, второй — проба, лид не пишется (до 08.11 менеджер его видел)', async () => {
    const base = { ...PERSON, car: 'Suzuki Jimny', date_from: DATE, date_to: inDays(33), test: true };
    const step1 = await call('create_car_rental_request', { ...base, consent: false });
    const code = /"([A-Za-z0-9_.-]{8,})"/.exec(step1.content[0]!.text)?.[1];
    expect(code, step1.content[0]!.text).toBeTruthy();
    const step2 = await call('create_car_rental_request', { ...base, confirmation: code });
    expect(step2.isError, step2.content[0]?.text).toBeUndefined();
    expect(step2.content[0]!.text).toMatch(/Пробная заявка \(test: true\)/);
    expect(step2.structuredContent?.requests[0]?.outcome).toBe('test');
    nothingSent();
  });

  it('строка "true" — тоже проба; без согласия проба отвечает тем же отказом, что заявка', async () => {
    const asString = await call('create_lead', { ...ARGS.create_lead, test: 'true' });
    expect(asString.structuredContent?.test).toBe(true);
    const noConsent = await call('create_lead', { ...ARGS.create_lead, consent: false, test: true });
    expect(noConsent.isError).toBe(true);
    expect(noConsent.content[0]!.text).toMatch(/нет согласия на обработку персональных данных/);
    nothingSent();
  });

  it('get_request_status читает пробный ключ состоянием test, ключ в базе не ищет', async () => {
    const r = await call('create_lead', { ...ARGS.create_lead, test: true });
    const key = r.structuredContent!.requests[0]!.status_key!;
    query.mockClear();
    const st = await call('get_request_status', { key });
    expect(st.isError).toBeUndefined();
    expect(JSON.parse(st.content[0]!.text)).toMatchObject({ state: 'test', kind: 'lead', consent_purpose: 'operator' });
    // Журнал вызова пишется как всегда; ключ в базе не ищется.
    expect(query.mock.calls.some(([sql]) => /agent_request_keys/.test(String(sql)))).toBe(false);
    const stay = issueTestKey('stay_request', 'stay');
    expect(JSON.parse((await call('get_request_status', { key: stay })).content[0]!.text)).toMatchObject({ state: 'test', kind: 'stay_request', consent_purpose: 'stay' });
  });

  it('пробный ключ не путается с настоящим: другая длина и вид', () => {
    expect(issueTestKey('lead', 'operator')).not.toHaveLength(32);
    expect(isTestKey('test_lead_op_' + 'a'.repeat(16))).toBe(true);
    expect(isTestKey('a'.repeat(32))).toBe(false);
    expect(isTestKey('test_' + 'a'.repeat(27))).toBe(false);
  });
});

describe('настоящая заявка: ключ, страница и подписка — структурно', () => {
  it('create_booking_request: accepted 1, ключ и страница с ключом, подписки нет — null', async () => {
    const r = await call('create_booking_request', ARGS.create_booking_request);
    expect(r.isError, r.content[0]?.text).toBeUndefined();
    const s = r.structuredContent!;
    expect(s).toMatchObject({ test: false, accepted: 1 });
    const q = s.requests[0]!;
    expect(q).toMatchObject({ tool: 'create_booking_request', outcome: 'accepted', notify: null });
    expect(q.status_key).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(q.status_page).toBe(`https://vedarai.ru/request-status#${q.status_key}`);
    // Тот же ключ — в тексте: структура не расходится с ответом.
    expect(r.content[0]!.text).toContain(q.status_key!);
    expect(createLeadMock).toHaveBeenCalledTimes(1);
  });

  it('заявка не создана (тура нет) — accepted 0, список пуст', async () => {
    query.mockImplementation(async (sql: string) => (/COUNT\(\*\)/.test(sql) ? { rows: [{ a: '0', b: '0', c: '0' }] } : { rows: [] }));
    const r = await call('create_booking_request', { ...ARGS.create_booking_request, tour: 'Несуществующий тур' });
    expect(r.structuredContent).toEqual({ test: false, accepted: 0, requests: [] });
  });

  it('у всех шести пишущих инструментов объявлены поле test и outputSchema', () => {
    const writers = PUBLIC_MCP_TOOLS.filter((t) => WRITE_TOOL_NAMES.has(t.name));
    expect(writers.map((t) => t.name).sort()).toEqual([...WRITE_TOOL_NAMES].sort());
    for (const t of writers) {
      expect((t.inputSchema as { properties: Record<string, { type?: string }> }).properties.test?.type, t.name).toBe('boolean');
      expect(t.outputSchema, t.name).toBe(WRITE_OUTPUT_SCHEMA);
    }
  });
});

describe('телефон, которого не бывает, — отказ до записи', () => {
  it('+70000000000 и номер из одних единиц — не номер; «красивый» номер — номер', () => {
    expect(implausiblePhone(normalizePhone('+70000000000')!)).toBe(true);
    expect(implausiblePhone(normalizePhone('+7 123 456-78-90')!)).toBe(true);
    expect(implausiblePhone(normalizePhone('+7 200 111-22-33')!)).toBe(true);
    expect(implausiblePhone('+1111111111')).toBe(true);
    expect(implausiblePhone(normalizePhone('+7 914 777-77-77')!)).toBe(false);
    expect(implausiblePhone(normalizePhone('8 999 999-99-99')!)).toBe(false);
    expect(implausiblePhone(normalizePhone('+7 701 123-45-67')!)).toBe(false); // Казахстан
    expect(implausiblePhone(normalizePhone('+49 30 1234567')!)).toBe(false);
  });

  for (const tool of ['create_lead', 'create_booking_request', 'create_stay_request', 'request_charter'] as const) {
    it(`${tool}: +70000000000 — отказ, лида нет; подсказка про test: true`, async () => {
      const r = await call(tool, { ...ARGS[tool], phone: '+70000000000' });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/Такого номера не бывает/);
      expect(r.content[0]!.text).toMatch(/test: true/);
      nothingSent();
    });
  }
});
