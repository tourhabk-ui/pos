/**
 * Публичный MCP — dual-era (ревизия 2026-07-28 рядом с прежними, 30.10).
 * Поведенчески, вызовом POST роута — не по исходнику.
 *
 * Правило: эпоху выбирает то, как клиент начал. `initialize` ведёт в legacy и
 * отвечает как раньше; версия в `params._meta` ведёт в modern — без
 * рукопожатия, с заголовками, сверенными с телом, `resultType` в каждом
 * результате и HTTP 404 на метод, которого нет. Партнёрский сервер — только
 * legacy (его сторож — tests/unit/partner-mcp-auth.test.ts).
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

import { POST, OPTIONS } from '@/app/api/mcp/route';
import { MCP_SERVER_INFO, PUBLIC_MCP_TOOLS } from '@/lib/mcp/public-tools';
import { SERVER_INSTRUCTIONS } from '@/lib/mcp/server-instructions';
import { SUPPORTED_PROTOCOL_VERSIONS, LEGACY_PROTOCOL_VERSIONS } from '@/lib/mcp/protocol-version';
import { decodeMcpHeaderValue } from '@/lib/mcp/modern-request';

const MODERN = '2026-07-28';
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';

let ipCounter = 0;
function post(body: unknown, headers: Record<string, string> = {}) {
  ipCounter += 1;
  return POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.8.0.${ipCounter % 250}`, ...headers },
    body: JSON.stringify(body),
  }));
}

function meta(version = MODERN): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientInfo': { name: 'TestClient', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

/** Modern-запрос с заголовками, как их ставит послушный клиент. */
function modern(method: string, params: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}, version = MODERN) {
  const headers: Record<string, string> = { 'mcp-protocol-version': version, 'mcp-method': method };
  if (typeof params.name === 'string') headers['mcp-name'] = params.name;
  return post({ jsonrpc: '2.0', id: 11, method, params: { ...params, _meta: meta(version) } }, { ...headers, ...extraHeaders });
}

beforeEach(() => {
  executeKuzmichTool.mockReset().mockResolvedValue('Погода: ясно');
});
afterEach(() => vi.restoreAllMocks());

describe('legacy-клиент — как до 2026-07-28', () => {
  it('initialize без _meta: legacy-версия, serverInfo, instructions, без resultType', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'old', version: '1' } } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result.protocolVersion).toBe('2025-06-18');
    expect(json.result.serverInfo.name).toBe(MCP_SERVER_INFO.name);
    expect(json.result.instructions).toBe(SERVER_INSTRUCTIONS);
    expect(json.result).not.toHaveProperty('resultType');
    expect(json.result).not.toHaveProperty('_meta');
  });

  it('initialize с просьбой 2026-07-28 в params — называет новейшую legacy: рукопожатия в modern нет', async () => {
    const json = await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MODERN } })).json();
    expect(json.result.protocolVersion).toBe(LEGACY_PROTOCOL_VERSIONS[0]);
  });

  it('legacy tools/list: без resultType, ttlMs и _meta; неизвестный метод — 200', async () => {
    const json = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': '2025-11-25' })).json();
    expect(json.result.tools.length).toBe(PUBLIC_MCP_TOOLS.length);
    expect(json.result).not.toHaveProperty('resultType');
    expect(json.result).not.toHaveProperty('ttlMs');
    const unknown = await post({ jsonrpc: '2.0', id: 3, method: 'server/discover' });
    expect(unknown.status).toBe(200);
    expect((await unknown.json()).error.code).toBe(-32601);
  });

  it('legacy-пакет по-прежнему принимается', async () => {
    const res = await post([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }]);
    expect(res.status).toBe(200);
    expect((await res.json() as Array<{ id: string }>).map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('modern-клиент: server/discover, tools/list, tools/call', () => {
  it('server/discover — версии обеих эпох, tools, instructions, serverInfo в _meta, кэш', async () => {
    const res = await modern('server/discover');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe(11);
    expect(json.result.resultType).toBe('complete');
    expect(json.result.supportedVersions).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
    expect(json.result.supportedVersions).toContain(MODERN);
    expect(json.result.capabilities).toEqual({ tools: {} });
    expect(json.result.instructions).toBe(SERVER_INSTRUCTIONS);
    expect(json.result._meta[SERVER_INFO_KEY].name).toBe(MCP_SERVER_INFO.name);
    expect(json.result._meta[SERVER_INFO_KEY].version).toBe(MCP_SERVER_INFO.version);
    expect(json.result.ttlMs).toBeGreaterThan(0);
    expect(json.result.cacheScope).toBe('public');
  });

  it('tools/list — тот же список, resultType, ttlMs и cacheScope', async () => {
    const json = await (await modern('tools/list')).json();
    expect(json.result.resultType).toBe('complete');
    expect(json.result.tools.map((t: { name: string }) => t.name)).toEqual(PUBLIC_MCP_TOOLS.map((t) => t.name));
    expect(json.result.ttlMs).toBeGreaterThan(0);
    expect(json.result.cacheScope).toBe('public');
    expect(json.result._meta[SERVER_INFO_KEY].name).toBe(MCP_SERVER_INFO.name);
  });

  it('tools/call читающего инструмента — ответ исполнителя, resultType complete', async () => {
    const res = await modern('tools/call', { name: 'get_weather', arguments: { location: 'Петропавловск-Камчатский' } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result.resultType).toBe('complete');
    expect(json.result.content[0].text).toContain('Погода: ясно');
    expect(json.result._meta[SERVER_INFO_KEY].name).toBe(MCP_SERVER_INFO.name);
    expect(executeKuzmichTool).toHaveBeenCalledTimes(1);
  });

  it('уведомление modern — пустой 202', async () => {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { _meta: meta() } }, { 'mcp-protocol-version': MODERN });
    expect(res.status).toBe(202);
  });
});

describe('сверка заголовков с телом — -32020 и HTTP 400', () => {
  it('Mcp-Name не совпал с params.name — инструмент не исполняется', async () => {
    const res = await modern('tools/call', { name: 'get_weather', arguments: {} }, { 'mcp-name': 'create_lead' });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.id).toBe(11);
    expect(json.error.code).toBe(-32020);
    expect(executeKuzmichTool).not.toHaveBeenCalled();
  });

  it('нет Mcp-Name у tools/call — -32020', async () => {
    const res = await post(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_weather', arguments: {}, _meta: meta() } },
      { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call' },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32020);
  });

  it('Mcp-Method не совпал с method — -32020', async () => {
    const res = await modern('tools/list', {}, { 'mcp-method': 'tools/call' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32020);
  });

  it('нет Mcp-Method — -32020', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta() } }, { 'mcp-protocol-version': MODERN });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32020);
  });

  it('MCP-Protocol-Version не совпал с _meta — -32020', async () => {
    const res = await post(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta() } },
      { 'mcp-protocol-version': '2025-11-25', 'mcp-method': 'tools/list' },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32020);
  });

  it('нет MCP-Protocol-Version при _meta с версией — -32020', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta() } }, { 'mcp-method': 'tools/list' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32020);
  });
});

describe('base64-форма Mcp-Name', () => {
  it('имя в форме =?base64?…?= декодируется до сравнения и проходит', async () => {
    const encoded = `=?base64?${Buffer.from('get_weather', 'utf-8').toString('base64')}?=`;
    const res = await modern('tools/call', { name: 'get_weather', arguments: {} }, { 'mcp-name': encoded });
    expect(res.status).toBe(200);
    expect((await res.json()).result.resultType).toBe('complete');
  });

  it('base64 чужого имени — -32020', async () => {
    const encoded = `=?base64?${Buffer.from('create_lead', 'utf-8').toString('base64')}?=`;
    const res = await modern('tools/call', { name: 'get_weather', arguments: {} }, { 'mcp-name': encoded });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32020);
  });

  it('декодер: UTF-8 из примера спеки, битая форма — null, обычное значение — как есть', () => {
    expect(decodeMcpHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?=')).toBe('Hello, 世界');
    expect(decodeMcpHeaderValue('=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=')).toBe('=?base64?literal?=');
    expect(decodeMcpHeaderValue('=?base64?не base64?=')).toBeNull();
    expect(decodeMcpHeaderValue('=?base64?/w==?=')).toBeNull();
    expect(decodeMcpHeaderValue('get_weather')).toBe('get_weather');
  });
});

describe('версия и обязательные поля _meta', () => {
  it('незнакомая версия — -32022, HTTP 400, data.supported и data.requested', async () => {
    const res = await modern('tools/list', {}, {}, '1900-01-01');
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe(-32022);
    expect(json.error.data.supported).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
    expect(json.error.data.requested).toBe('1900-01-01');
  });

  it('legacy-версия в _meta — тоже -32022: legacy начинается с initialize', async () => {
    const res = await modern('tools/list', {}, {}, '2025-11-25');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32022);
  });

  it('нет clientCapabilities — -32602 и HTTP 400', async () => {
    const res = await post(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } } },
      { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32602);
  });

  it('заголовок 2026-07-28 без _meta в теле — -32602 и HTTP 400, а не тихий legacy', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32602);
  });
});

describe('метода нет — HTTP 404 и -32601', () => {
  it('resources/list — 404', async () => {
    const res = await modern('resources/list');
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.id).toBe(11);
    expect(json.error.code).toBe(-32601);
  });

  it('initialize в modern — 404 -32601, отказ называет версии', async () => {
    const res = await modern('initialize');
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe(-32601);
    expect(json.error.data.supported).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
    expect(json.error.message).toContain(LEGACY_PROTOCOL_VERSIONS[0]);
  });

  it('ping в modern — 404 -32601 (метод удалён в 2026-07-28)', async () => {
    const res = await modern('ping');
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe(-32601);
  });

  it('пакет с modern-сообщением — -32600 и 400: в 2026-07-28 пакетов нет', async () => {
    const res = await post([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta() } }], { 'mcp-protocol-version': MODERN });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
  });
});

describe('CORS', () => {
  it('предполёт пускает Mcp-Method и Mcp-Name', async () => {
    const allowed = (await OPTIONS()).headers.get('access-control-allow-headers') ?? '';
    const names = allowed.split(',').map((h) => h.trim().toLowerCase());
    expect(names).toEqual(expect.arrayContaining(['mcp-method', 'mcp-name', 'mcp-protocol-version']));
  });
});
