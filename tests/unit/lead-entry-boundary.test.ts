/**
 * Граница вызова инструмента ставит вход заявки (слово владельца 08.11:
 * «откуда лиды — человек или ИИ и через какой инструмент: ТГ, MAX, MCP, A2A
 * или на сайте Кузьмич»).
 *
 * До 08.11 MCP, A2A и чат Кузьмича создавали заявку одними функциями, и каждая
 * записывалась как `source: 'mcp'`. Судится вызовом: POST /api/mcp и
 * runPublicTool с признаками A2A и чата до момента записи заявки — запись
 * подменена и читает вход, который видит в этот момент. Что вход доходит до
 * INSERT — lead-entry-stamp.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { currentLeadEntry, type LeadEntryContext } from '@/lib/leads/entry-context';

const { seen, query, partnerOrigins } = vi.hoisted(() => ({
  seen: [] as Array<LeadEntryContext | null>,
  query: vi.fn(),
  partnerOrigins: [] as Array<string | undefined>,
}));

vi.mock('@/lib/leads/create', () => ({
  createLead: async () => { seen.push(currentLeadEntry()); return 'lead-1'; },
  createLeadDetailed: async () => { seen.push(currentLeadEntry()); return { id: 'lead-1', created: true }; },
  findRecentLeadByCommentPrefix: async () => null,
}));
vi.mock('@/lib/kuzmich/core', () => ({ executeKuzmichTool: async () => 'ok' }));
// Личное уведомление оператору: что в строке «Откуда», а не сама отправка.
vi.mock('@/lib/notifications/lead-notify', () => ({
  notifyPartnerNewLeadPersonally: async (p: { origin?: string }) => { partnerOrigins.push(p.origin); return { state: 'no_channel' }; },
}));
vi.mock('@/lib/leads/delivery-outcome', () => ({ recordPartnerDelivery: async () => undefined }));
vi.mock('@/lib/requests/operator-predraft', () => ({ operatorPredraft: async () => [] }));
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => ({}),
  fetchAvailabilityForTour: async (_id: string, from: string) => [{ date: from, remaining: 10, priceOverride: null }],
}));
vi.mock('@/lib/db-pool', () => ({
  pool: { query, connect: async () => ({ query, release: () => {} }) },
}));

import { POST, runPublicTool } from '@/app/api/mcp/route';

// Телефон правдоподобный: заявка MCP с +70000000000 отвергается до записи (#3155).
const TOUR = { id: 27, title: 'Сплав по реке Быстрая', operator_id: 'op-uuid-1', base_price: 13000, price_unit: 'person' };
const LEAD = { name: 'Тест Тестов', phone: '+79001234567', comment: 'Хотим на вулкан в августе, 4 человека, бюджет 200000 руб', consent: true };
const BOOKING = { tour: '27', date: '2027-07-10', participants: 2, name: 'Тест Тестов', phone: '+79001234567', consent: true };

let ip = 0;
const nextIp = () => { ip += 1; return `10.8.${Math.floor(ip / 250)}.${ip % 250}`; };

beforeEach(() => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  seen.length = 0;
  partnerOrigins.length = 0;
  query.mockReset().mockImplementation(async (sql: string) => {
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ a: '0', b: '0', c: '0' }] };
    if (/FROM operator_tours/.test(sql)) return { rows: [TOUR] };
    return { rows: [] };
  });
});

describe('вход заявки в момент записи', () => {
  it('POST /api/mcp — вход mcp и имя инструмента', async () => {
    const res = await POST(new NextRequest('http://localhost/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': nextIp() },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_lead', arguments: LEAD } }),
    }));
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ entry: 'mcp', tool: 'create_lead' }]);
  });

  it('A2A (via) — вход a2a', async () => {
    const out = await runPublicTool({ toolName: 'create_lead', rawArguments: LEAD, ip: nextIp(), userAgent: 'test', self: false, via: 'a2a' });
    expect(out.kind).toBe('ok');
    expect(seen).toEqual([{ entry: 'a2a', tool: 'create_lead' }]);
  });

  it.each(['kuzmich-web', 'kuzmich-tg', 'kuzmich-max'] as const)('чат Кузьмича (%s) — вход чата, а не mcp', async (source) => {
    await runPublicTool({
      toolName: 'create_booking_request', rawArguments: BOOKING, ip: nextIp(), userAgent: 'test', self: false,
      consentFrom: { source, ip: null },
    });
    expect(seen).toEqual([{ entry: source, tool: 'create_booking_request' }]);
  });

  it('оператор тура получает «Откуда» по входу вызова — чат Кузьмича не выдан за MCP', async () => {
    await runPublicTool({
      toolName: 'create_booking_request', rawArguments: BOOKING, ip: nextIp(), userAgent: 'test', self: false,
      consentFrom: { source: 'kuzmich-tg', ip: null },
    });
    await vi.waitFor(() => expect(partnerOrigins).toEqual(['Человек · Кузьмич в Telegram · заявка на тур']));
    partnerOrigins.length = 0;
    await runPublicTool({ toolName: 'create_booking_request', rawArguments: BOOKING, ip: nextIp(), userAgent: 'test', self: false, via: 'a2a' });
    await vi.waitFor(() => expect(partnerOrigins).toEqual(['ИИ-агент · A2A · заявка на тур']));
  });

  it('после вызова входа нет: следующая запись вне инструмента его не наследует', async () => {
    await runPublicTool({ toolName: 'create_lead', rawArguments: LEAD, ip: nextIp(), userAgent: 'test', self: false, via: 'a2a' });
    expect(currentLeadEntry()).toBeNull();
  });
});
