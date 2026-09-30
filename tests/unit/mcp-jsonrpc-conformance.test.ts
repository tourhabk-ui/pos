/**
 * Публичный MCP говорит на JSON-RPC 2.0 и Streamable HTTP по правилам
 * (проверка MCP 29.09). Поведенчески, через POST роута — не по исходнику.
 *
 * До этого дня:
 *   - любое уведомление, кроме initialized (cancelled шлёт SDK при таймауте),
 *     и ответ клиента получали HTTP 400 с телом-ошибкой вместо пустого 202;
 *   - пакет читался как «Method not found: undefined», хотя объявленная
 *     ревизия 2025-03-26 требует пакеты принимать; тело null роняло роут 500;
 *   - неизвестный метод уходил с HTTP 400 — клиент SDK на не-2xx бросает
 *     транспортную ошибку и кода -32601 не видит;
 *   - заголовок MCP-Protocol-Version не читался вовсе;
 *   - отказ исполнителя Кузьмича («Ошибка при выполнении запроса.») уходил
 *     успехом, а чужое исключение — анониму текстом как есть;
 *   - рукопожатие не передавало instructions и serverInfo.title.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const { executeKuzmichTool } = vi.hoisted(() => ({ executeKuzmichTool: vi.fn() }));
vi.mock('@/lib/kuzmich/core', () => ({ executeKuzmichTool }));
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() })),
  },
}));

import { POST } from '@/app/api/mcp/route';
import { TOOL_EXECUTION_FAILED } from '@/lib/kuzmich/tool-failure';
import { MCP_INTERNAL_ERROR_TEXT } from '@/lib/mcp/jsonrpc';

let ipCounter = 0;
function post(body: unknown, headers: Record<string, string> = {}) {
  ipCounter += 1;
  return POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    // Свой адрес на каждый запрос — лимит чтения в памяти общий на модуль.
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.9.0.${ipCounter % 250}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

const call = (name: string, args: Record<string, unknown> = {}) =>
  ({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });

beforeEach(() => {
  executeKuzmichTool.mockReset().mockResolvedValue('Погода: ясно');
});
afterEach(() => vi.restoreAllMocks());

describe('уведомления и ответы клиента — пустой 202', () => {
  it('notifications/cancelled без id — 202 без тела', async () => {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('notifications/initialized — как и прежде', async () => {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
  });

  it('ответ клиента на запрос сервера — 202', async () => {
    const res = await post({ jsonrpc: '2.0', id: 5, result: {} });
    expect(res.status).toBe(202);
  });
});

describe('неверные сообщения — -32600, а не 500', () => {
  for (const [label, body] of [['null', 'null'], ['число', '42'], ['jsonrpc 1.0', { jsonrpc: '1.0', id: 1, method: 'ping' }], ['method не строка', { jsonrpc: '2.0', id: 1, method: 5 }]] as const) {
    it(label, async () => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe(-32600);
    });
  }

  it('битый JSON — -32700', async () => {
    const res = await post('{"jsonrpc":');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });
});

describe('ошибки метода — телом JSON-RPC с HTTP 200', () => {
  it('неизвестный метод — -32601', async () => {
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe(2);
    expect(json.error.code).toBe(-32601);
  });

  it('неизвестный инструмент — -32602, исполнитель не зовётся', async () => {
    const json = await (await post(call('no_such_tool'))).json();
    expect(json.error.code).toBe(-32602);
    expect(executeKuzmichTool).not.toHaveBeenCalled();
  });
});

describe('пакеты (ревизия 2025-03-26)', () => {
  it('ответы — только на запросы с id, в порядке пакета', async () => {
    const res = await post([
      { jsonrpc: '2.0', id: 'a', method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
    ]);
    expect(res.status).toBe(200);
    const json = await res.json() as Array<{ id: string }>;
    expect(json.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('одни уведомления — 202', async () => {
    const res = await post([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
    expect(res.status).toBe(202);
  });

  it('пустой пакет — -32600', async () => {
    const res = await post([]);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
  });

  it('пакет длиннее предела обрабатывается до предела и говорит об остатке', async () => {
    const res = await post(Array.from({ length: 25 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' })));
    const json = await res.json() as Array<{ id: number | null; error?: { code: number } }>;
    expect(json.filter((r) => !r.error)).toHaveLength(20);
    expect(json.at(-1)?.error?.code).toBe(-32600);
  });
});

describe('заголовок MCP-Protocol-Version (ревизия 2025-06-18)', () => {
  it('неподдерживаемая версия — 400', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' });
    expect(res.status).toBe(400);
  });

  it('поддерживаемая версия и её отсутствие — работают', async () => {
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': '2025-06-18' })).status).toBe(200);
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
  });
});

describe('рукопожатие', () => {
  it('отдаёт instructions и serverInfo.title', async () => {
    const json = await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
    expect(json.result.serverInfo.title).toBe('Ведар — Камчатка');
    expect(typeof json.result.instructions).toBe('string');
    expect(json.result.instructions).toMatch(/112/);
  });
});

describe('отказ инструмента — isError, а не успех', () => {
  it('исполнитель Кузьмича упал — isError, без ссылки «продолжить»', async () => {
    executeKuzmichTool.mockResolvedValue(TOOL_EXECUTION_FAILED);
    const json = await (await post(call('get_weather'))).json();
    expect(json.result.isError).toBe(true);
    expect(json.result.content).toHaveLength(1);
    expect(json.result.content[0].text).toMatch(/сбой на стороне Ведара/);
  });

  it('чужое исключение — общий текст наружу, подробность в лог', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    executeKuzmichTool.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    const json = await (await post(call('get_weather'))).json();
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toBe(MCP_INTERNAL_ERROR_TEXT);
    expect(JSON.stringify(json)).not.toMatch(/ECONNREFUSED|5432/);
    expect(err.mock.calls.some((c) => String(c.join(' ')).includes('ECONNREFUSED'))).toBe(true);
  });

  it('текст для агента (отказ валидации записи) уходит как есть', async () => {
    const json = await (await post(call('create_lead', { name: 'Иван', phone: '+79001234567', comment: 'Хочу на вулкан в августе' }))).json();
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/нет поля consent/);
  });
});

describe('размер тела и CORS (проверка MCP 29.09)', () => {
  it('тело больше предела — 413 до разбора', async () => {
    const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70 * 1024) } });
    const res = await post(huge);
    expect(res.status).toBe(413);
  });

  it('ответ POST несёт Access-Control-Allow-Origin — браузер может его прочитать', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('и 202 на уведомление, и ошибка разбора — тоже', async () => {
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).headers.get('access-control-allow-origin')).toBe('*');
    expect((await post('{')).headers.get('access-control-allow-origin')).toBe('*');
  });
});
