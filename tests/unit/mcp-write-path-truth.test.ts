/**
 * Пишущий путь MCP говорит правду о заявке (проверка MCP 29.09, D6).
 *
 * Находки скептиков, каждая — поведенчески, через POST роута:
 *   W1 — заявка на бронь ложилась без оператора: он её не видел;
 *   W2 — «900 123-45-67» становился «+9001234567»;
 *   W4 — заявка ниже порога качества закрывалась createLead молча, а агенту
 *        отвечали «менеджер свяжется»;
 *   W5 — номер тура, которого нет на витрине, проваливался в поиск «%7%» и
 *        заявка уходила по другому туру;
 *   W8 — несуществующая дата падала в базе общим «внутренняя ошибка»;
 *   W9 — отказ лимита записи обещал «подождите минуту» при окне в 10 минут;
 *   W12 — перевод строки в имени подделывал строку телефона в уведомлении;
 *   W14 — consent строкой получал текст «поля нет»; zod отвечал по-английски.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { createLeadMock, query } = vi.hoisted(() => ({
  createLeadMock: vi.fn(async (_: Record<string, unknown>) => 'lead-1'),
  query: vi.fn(),
}));

vi.mock('@/lib/leads/create', () => ({
  createLead: (p: Record<string, unknown>) => createLeadMock(p),
  findRecentLeadByCommentPrefix: async () => null,
}));
vi.mock('@/lib/kuzmich/core', () => ({ executeKuzmichTool: async () => 'ok' }));
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => ({}),
  fetchAvailabilityForTour: async (_id: string, from: string) => [{ date: from, remaining: 10, priceOverride: null }],
}));
vi.mock('@/lib/db-pool', () => ({
  pool: { query, connect: async () => ({ query, release: () => {} }) },
}));

import { POST } from '@/app/api/mcp/route';
import { normalizePhone } from '@/lib/mcp/normalize-phone';
import { resolveTourByQuery } from '@/lib/kuzmich/tour-availability-tool';

const TOUR = { id: 27, title: 'Сплав по реке Быстрая', operator_id: 'op-uuid-1', base_price: 13000, price_unit: 'person' };

let ip = 0;
function call(name: string, args: Record<string, unknown>, sameIp?: string) {
  ip += 1;
  return POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': sameIp ?? `10.7.${Math.floor(ip / 250)}.${ip % 250}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
}
const result = async (res: Response) => (await res.json()).result as { isError?: boolean; content: Array<{ text: string }> };

const BOOKING = { tour: 'Сплав', date: '2027-07-10', participants: 2, name: 'Иван Петров', phone: '+79001234567', consent: true };
const LEAD = { name: 'Иван Петров', phone: '+79001234567', comment: 'Хотим на вулкан в августе, 4 человека, бюджет 200000 руб', consent: true };

beforeEach(() => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  createLeadMock.mockClear();
  query.mockReset().mockImplementation(async (sql: string) => {
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ a: '0', b: '0', c: '0' }] };
    if (/FROM operator_tours/.test(sql)) return { rows: [TOUR] };
    return { rows: [] };
  });
});

describe('W1: заявка на бронь ложится оператору тура', () => {
  it('createLead получает operator_id тура', async () => {
    const r = await result(await call('create_booking_request', BOOKING));
    expect(r.isError).toBeUndefined();
    expect(createLeadMock).toHaveBeenCalledWith(expect.objectContaining({ operator_id: 'op-uuid-1' }));
  });
});

describe('W2: десять цифр без кода страны — российский номер', () => {
  it('900 123-45-67 → +79001234567; с плюсом — как есть', () => {
    expect(normalizePhone('900 123-45-67')).toBe('+79001234567');
    expect(normalizePhone('+1 212 555 1234')).toBe('+12125551234');
  });
});

describe('W4: заявка, которую никто не увидит, — отказ до записи', () => {
  it('имя из двух букв — «слишком неполная», createLead не зовётся', async () => {
    const r = await result(await call('create_lead', { ...LEAD, name: 'Ян' }));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/слишком неполная/);
    expect(createLeadMock).not.toHaveBeenCalled();
  });

  it('обычная заявка проходит, номер заявки не называется', async () => {
    const r = await result(await call('create_lead', LEAD));
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toMatch(/Заявка принята/);
    expect(r.content[0]!.text).not.toMatch(/lead-1|номер/);
  });
});

describe('W5: номер тура не проваливается в поиск по названию', () => {
  it('ID без тура на витрине — null, без ILIKE', async () => {
    query.mockImplementation(async () => ({ rows: [] }));
    expect(await resolveTourByQuery('7')).toBeNull();
    expect(query.mock.calls.some((c) => /ILIKE/.test(String(c[0])))).toBe(false);
  });
});

describe('W8/W12/W14: отказы — внятные и по-русски', () => {
  it('несуществующая дата — «нет в календаре»', async () => {
    const r = await result(await call('create_booking_request', { ...BOOKING, date: '2027-02-30' }));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/нет в календаре/);
  });

  it('перевод строки в имени не проходит', async () => {
    const r = await result(await call('create_lead', { ...LEAD, name: 'Иван\nТел: +79990000000' }));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/одной строкой/);
    expect(createLeadMock).not.toHaveBeenCalled();
  });

  it('consent строкой — свой текст, не «поля нет»', async () => {
    const r = await result(await call('create_lead', { ...LEAD, consent: 'true' }));
    expect(r.content[0]!.text).toMatch(/логическим значением/);
    expect(r.content[0]!.text).not.toMatch(/нет поля consent/);
  });

  it('участники словом — русское сообщение', async () => {
    const r = await result(await call('create_booking_request', { ...BOOKING, participants: 'два' }));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Число участников/);
  });
});

describe('W9: лимит записи называет своё окно', () => {
  // Окно — час (решение владельца 01.10: 5 заявок в час с адреса).
  it('шестая заявка с адреса — «подождите час»', async () => {
    let last: { isError?: boolean; content: Array<{ text: string }> } | null = null;
    for (let i = 0; i < 6; i++) last = await result(await call('create_lead', LEAD, '10.66.66.66'));
    expect(last!.isError).toBe(true);
    expect(last!.content[0]!.text).toMatch(/подождите час/);
  });
});
