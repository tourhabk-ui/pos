/**
 * Заявка на группу больше, чем тур берёт на выезд (слово владельца 08.11):
 * запросом оператору тура, а не отказом; отказ остаётся, где дата занята, а
 * группа в потолок тура входит. Вызовом роута.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import Ajv from 'ajv';
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
import { WRITE_OUTPUT_SCHEMA } from '@/lib/mcp/test-run';


const TOUR = { id: 70, title: 'Восхождение на вулкан Горелый', operator_id: 'op-uuid-1', base_price: 15000, price_unit: 'person', nearest_free_date: null };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const DATE = inDays(40);
/** Строка тура для loadTourGroupFacts; Error — чтение падает. */
let facts: Record<string, unknown> | Error = { max_participants: 12, group_size_unlimited: true, activity_type: 'trekking' };

let ip = 0;
async function call(args: Record<string, unknown>) {
  ip += 1;
  const res = await POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.11.${Math.floor(ip / 250)}.${ip % 250}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_booking_request', arguments: args } }),
  }));
  return (await res.json()).result as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
}
const BASE = { name: 'Иван Петров', phone: '+79001234567', consent: true, tour: '70', date: DATE };

beforeEach(() => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  avail.remaining = 4;
  avail.keepsSchedule = true;
  facts = { max_participants: 12, group_size_unlimited: true, activity_type: 'trekking' };
  for (const m of [createLeadMock, seatRequestMock, sendPdAlertMock, partnerNotifyMock, personalNotifyMock]) m.mockClear();
  sendPdAlertMock.mockResolvedValue({ delivered: true, channel: 'max', reason: 'доставлено в MAX' });
  seatRequestMock.mockResolvedValue({ ok: true, requestId: 'sr-1', statusToken: 'tok', deadlineAt: new Date(Date.now() + 7_200_000) });
  query.mockReset().mockImplementation(async (sql: string) => {
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ a: '0', b: '0', c: '0' }] };
    if (/SELECT max_participants, group_size_unlimited, activity_type FROM operator_tours/.test(sql)) {
      if (facts instanceof Error) throw facts;
      return { rows: [facts] };
    }
    if (/FROM operator_tours/.test(sql)) return { rows: [TOUR] };
    return { rows: [] };
  });
});

const lead = () => createLeadMock.mock.calls[0]?.[0] as { operator_id?: string; comment: string; source_data: Record<string, unknown> };

describe('заявка на группу больше мест — запросом оператору (слово владельца 08.11)', () => {
  it('группа не ограничена, на дату 4 места, вас 24: заявка оператору тура, не отказ', async () => {
    const r = await call({ ...BASE, participants: 24 });
    expect(r.isError, r.content[0]?.text).toBeUndefined();
    expect(createLeadMock).toHaveBeenCalledTimes(1);
    expect(lead().operator_id).toBe('op-uuid-1');
    expect(lead().comment).toContain('Группа больше мест: на дату свободно 4 мест, а в группе 24 чел. Возьмёте ли всю группу');
    expect(lead().source_data).toMatchObject({ group_over_seats: true, seats_on_date: 4, interests: ['trekking'], participants: 24 });
    expect(r.content[0]!.text).toMatch(/Заявка оператору отправлена запросом на всю группу/);
    expect(r.content[0]!.text).toMatch(/Места не закреплены/);
    expect(r.content[0]!.text).toMatch(/Если он откажет, заявку на группу увидят другие операторы/);
    expect(r.structuredContent?.group).toEqual({ code: 'group_over_seats', tour_id: 70, seats_on_date: 4, tour_max: null, participants: 24 });
    expect(new Ajv({ strict: false }).validate(WRITE_OUTPUT_SCHEMA, r.structuredContent)).toBe(true);
  });

  it('группа в потолок заявки (10 из 12), а на дату 4: у тура без потолка группы — запрос, у обычного — отказ', async () => {
    facts = { max_participants: 12, group_size_unlimited: true, activity_type: 'trekking' };
    const unlimited = await call({ ...BASE, participants: 10 });
    expect(createLeadMock).toHaveBeenCalledTimes(1);
    expect(unlimited.structuredContent?.group).toEqual({ code: 'group_over_seats', tour_id: 70, seats_on_date: 4, tour_max: null, participants: 10 });
    createLeadMock.mockClear();
    facts = { max_participants: 12, group_size_unlimited: false, activity_type: 'trekking' };
    const capped = await call({ ...BASE, participants: 10 });
    expect(createLeadMock).not.toHaveBeenCalled();
    expect(capped.content[0]!.text).toMatch(/только 4 мест, а нужно 10 — заявка не создана/);
  });

  it('группа больше потолка тура (до 4) — тоже запрос, с потолком в словах', async () => {
    facts = { max_participants: 4, group_size_unlimited: false, activity_type: 'volcano' };
    const r = await call({ ...BASE, participants: 24 });
    expect(createLeadMock).toHaveBeenCalledTimes(1);
    expect(r.content[0]!.text).toContain('тур берёт до 4 чел. (так записано у тура), а в группе 24 чел.');
    expect(r.structuredContent?.group).toMatchObject({ tour_max: 4, seats_on_date: 4 });
  });

  it('группа входит в потолок, а дата занята — прежний отказ с ближайшими датами', async () => {
    facts = { max_participants: 10, group_size_unlimited: false, activity_type: 'volcano' };
    avail.remaining = 2;
    const r = await call({ ...BASE, participants: 5 });
    expect(createLeadMock).not.toHaveBeenCalled();
    expect(r.content[0]!.text).toMatch(/только 2 мест, а нужно 5 — заявка не создана/);
    expect(r.structuredContent?.group).toBeUndefined();
  });

  it('без расписания: группа сверх потолка — заявка оператору, в потолке — запрос мест, как прежде', async () => {
    avail.keepsSchedule = false;
    avail.remaining = 0;
    facts = { max_participants: 12, group_size_unlimited: true, activity_type: 'trekking' };
    const big = await call({ ...BASE, participants: 24 });
    expect(createLeadMock).toHaveBeenCalledTimes(1);
    expect(seatRequestMock).not.toHaveBeenCalled();
    expect(big.content[0]!.text).toContain('расписания у тура в системе нет, а в группе 24 чел.');
    createLeadMock.mockClear();
    await call({ ...BASE, participants: 6 });
    expect(seatRequestMock).toHaveBeenCalledTimes(1);
    expect(createLeadMock).not.toHaveBeenCalled();
  });

  it('группу тура прочитать не удалось — прежний путь (отказ по местам), не запрос наугад', async () => {
    facts = new Error('connection terminated');
    const r = await call({ ...BASE, participants: 24 });
    expect(createLeadMock).not.toHaveBeenCalled();
    expect(r.content[0]!.text).toMatch(/заявка не создана/);
  });

  it('проба (test: true) называет запрос на всю группу и ничего не пишет', async () => {
    const r = await call({ ...BASE, participants: 24, test: true });
    expect(r.content[0]!.text).toMatch(/Без test: true ушла бы: запрос оператору на всю группу/);
    expect(createLeadMock).not.toHaveBeenCalled();
    expect(r.structuredContent).toMatchObject({ test: true, group: { code: 'group_over_seats' } });
  });
});

describe('описание create_booking_request называет запрос на группу (аудит 09.11)', () => {
  it('«при 0 мест заявка не создаётся» — с исключением для группы сверх выезда', async () => {
    // Аудит 09.11: описание обещало «нет мест — заявки нет», а проба отвечала
    // «ушёл бы запрос оператору на всю группу». Поведение — слово владельца
    // 08.11; описание обязано его называть, иначе агент обещает человеку отказ.
    const { BOOKING_REQUEST_TOOL } = await import('@/lib/mcp/public-tools');
    expect(BOOKING_REQUEST_TOOL.description).toMatch(/Нет мест на дату — заявки нет/);
    expect(BOOKING_REQUEST_TOOL.description).toMatch(/Запрос оператору вместо отказа, без закрепления мест[^.]*группа больше, чем тур берёт на выезд, или группа у тура не ограничена — запрос на всю группу/);
  });
});
