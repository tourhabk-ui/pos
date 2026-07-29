/**
 * MCP create_lead — единственный пишущий инструмент публичного MCP.
 *
 * Инварианты:
 * - заявка идёт в общий createLead() (скоринг/дедуп/уведомление), не в свой SQL;
 * - телефон обязателен — заявка без контакта бесполезна менеджеру;
 * - невалидные аргументы дают isError-ответ, createLead не вызывается;
 * - квотные инструменты (search_kamchatka/search_taaft) наружу не отдаются.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createLeadMock = vi.fn(async () => 'lead-123');

vi.mock('@/lib/leads/create', () => ({
  createLead: (...args: unknown[]) => createLeadMock(...(args as [])),
}));

vi.mock('@/lib/kuzmich/tool-schemas', () => ({
  TOOL_REGISTRY: {
    get_weather: {
      definition: {
        function: {
          name: 'get_weather',
          description: 'погода',
          parameters: { type: 'object', properties: {} },
        },
      },
    },
    search_kamchatka: {
      definition: {
        function: {
          name: 'search_kamchatka',
          description: 'платный веб-поиск',
          parameters: { type: 'object', properties: {} },
        },
      },
    },
  },
  validateToolArgs: () => ({ ok: true, args: {} }),
}));

vi.mock('@/lib/kuzmich/core', () => ({
  executeKuzmichTool: async () => 'ok',
}));

import { POST, GET } from '@/app/api/mcp/route';

function rpc(method: string, params?: Record<string, unknown>) {
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    // NextRequest-совместимо: роут читает только .json()
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  createLeadMock.mockClear();
});

describe('MCP create_lead', () => {
  it('tools/list отдаёт create_lead и НЕ отдаёт квотные инструменты', async () => {
    const res = await POST(rpc('tools/list'));
    const json = await res.json();
    const names = json.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('create_lead');
    expect(names).toContain('get_weather');
    expect(names).not.toContain('search_kamchatka');
    expect(names).not.toContain('search_taaft');
  });

  it('валидная заявка уходит в общий createLead с source mcp', async () => {
    const res = await POST(rpc('tools/call', {
      name: 'create_lead',
      arguments: {
        name: 'Иван',
        phone: '+7 900 000-00-00',
        comment: 'Хотим на Толбачик в августе, двое взрослых',
        interest: 'Толбачик',
      },
    }));
    const json = await res.json();
    expect(json.result.isError).toBeUndefined();
    expect(json.result.content[0].text).toContain('Заявка принята');
    expect(createLeadMock).toHaveBeenCalledTimes(1);
    const arg = createLeadMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.phone).toBe('+7 900 000-00-00');
    expect(arg.comment).toContain('Толбачик');
    expect(arg.source_url).toBe('mcp://vedar');
    expect((arg.source_data as Record<string, unknown>).source).toBe('mcp');
  });

  it('без телефона — isError, createLead не вызывается', async () => {
    const res = await POST(rpc('tools/call', {
      name: 'create_lead',
      arguments: { name: 'Иван', comment: 'Хотим на Толбачик в августе' },
    }));
    const json = await res.json();
    expect(json.result.isError).toBe(true);
    expect(createLeadMock).not.toHaveBeenCalled();
  });

  it('слишком короткий запрос — isError с понятным русским текстом', async () => {
    const res = await POST(rpc('tools/call', {
      name: 'create_lead',
      arguments: { name: 'Иван', phone: '+79000000000', comment: 'тур' },
    }));
    const json = await res.json();
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain('10 символах');
  });

  it('GET-описание сервера упоминает create_lead', async () => {
    const res = await GET();
    const json = await res.json();
    expect(json.description).toContain('create_lead');
  });
});
