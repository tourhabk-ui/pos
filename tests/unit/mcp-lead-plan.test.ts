/**
 * MCP create_lead с plan_id — заявка уходит с планом целиком (#2304, шаг 2).
 *
 * Проверяется на живом пути роута, как и согласие в mcp-lead-tool.test.ts:
 * связка «схема → роут → createLead» рвётся тихо — сторож по исходнику видел
 * вызов загрузчика плана, но не то, что план доходит до заявки.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createLeadMock = vi.fn(async () => 'lead-123');
vi.mock('@/lib/leads/create', () => ({
  createLead: (...args: unknown[]) => createLeadMock(...(args as [])),
  findRecentLeadByCommentPrefix: async () => null,
}));

let DRAFT: unknown = { kind: 'missing' };
vi.mock('@/lib/planner/plan-drafts', () => ({
  loadDraft: async () => DRAFT,
  isDraftId: (raw: string | undefined) => typeof raw === 'string' && /^[0-9a-f-]{36}$/.test(raw),
}));

vi.mock('@/lib/kuzmich/tool-schemas', () => ({
  TOOL_REGISTRY: {},
  validateToolArgs: () => ({ ok: true, args: {} }),
}));
vi.mock('@/lib/kuzmich/core', () => ({ executeKuzmichTool: async () => 'ok' }));
vi.mock('@/lib/db-pool', () => {
  const q = async (sql: string) =>
    /COUNT\(\*\)/.test(sql) ? { rows: [{ a: '0', b: '0', c: '0' }] } : { rows: [] };
  return { pool: { query: q, connect: async () => ({ query: q, release: () => {} }) } };
});

import { POST } from '@/app/api/mcp/route';

function rpc(method: string, params?: Record<string, unknown>) {
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }) as unknown as Parameters<typeof POST>[0];
}

const ID = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const LEAD = {
  name: 'Иван Петров',
  phone: '+7 900 000-00-00',
  comment: 'Хотим по плану из чата, двое взрослых и ребёнок',
  consent: true,
};

beforeEach(() => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  createLeadMock.mockClear();
});

describe('MCP create_lead с plan_id', () => {
  it('план найден — в заявку ложится сводка: состав, туры по дням, смета', async () => {
    DRAFT = { kind: 'found', draft: { id: ID, revision: 2, params: {
      interests: ['fishing'], arrivalDate: '2027-08-02', departureDate: '2027-08-04', adults: 2, children: [7], budgetTier: 'comfort',
    }, days: [
      { day: 1, type: 'arrival', zone: 'avachinsky', title: 'Прилёт', priceFrom: 0, priceTo: 0 },
      { day: 2, type: 'activity', zone: 'western', title: 'Рыбалка на базе', priceFrom: 28000, priceTo: 33600, realPrice: 28000,
        realTour: { tourId: '5', priceUnit: 'per_day_per_person', durationDays: 1, lodgingIncluded: true, operatorName: 'Камчатская рыбалка' } },
      { day: 3, type: 'departure', zone: 'avachinsky', title: 'Вылет', priceFrom: 0, priceTo: 0 },
    ] } };
    const res = await POST(rpc('tools/call', { name: 'create_lead', arguments: { ...LEAD, plan_id: ID } }));
    const json = await res.json();
    expect(json.result.isError).toBeUndefined();
    expect(json.result.content[0].text).toBe('Заявка принята. Менеджер Ведара свяжется по указанному телефону.');
    const sd = (createLeadMock.mock.calls[0]![0] as unknown as { source_data: Record<string, unknown> }).source_data;
    expect(sd.source).toBe('mcp');
    expect(sd.plan_id).toBe(ID);
    const plan = sd.plan as { party: unknown; days: Array<{ tour?: { id: string; price?: number } }>; estimate: { total: [number, number] } };
    expect(plan.party).toEqual({ adults: 2, children: [7] });
    expect(plan.days[1]!.tour).toMatchObject({ id: '5', price: 28000 });
    // 28 000 × 1 день × 3 чел.
    expect(plan.estimate.total[0]).toBeGreaterThanOrEqual(28000 * 3);
  });

  it('плана нет — заявка всё равно создаётся, и агент слышит, что без плана', async () => {
    DRAFT = { kind: 'missing' };
    const res = await POST(rpc('tools/call', { name: 'create_lead', arguments: { ...LEAD, plan_id: ID } }));
    const json = await res.json();
    expect(json.result.isError).toBeUndefined();
    expect(json.result.content[0].text).toMatch(/Заявка принята\..* не найден .* заявка принята без плана/);
    const sd = (createLeadMock.mock.calls[0]![0] as unknown as { source_data: Record<string, unknown> }).source_data;
    expect(sd.plan).toBeUndefined();
  });
});
