/**
 * WebMCP: инструменты Ведара на странице (слово владельца 20.11 «Сделай WebMCP»).
 *
 * Судится поведение (CLAUDE.md §4, 13.10): что страница регистрирует в
 * браузере, с какими описаниями, что уходит на сервер и что получает агент.
 *
 *  - нет API — нет ни запроса, ни регистрации;
 *  - отдаются только инструменты чтения: каждый есть в публичном MCP с
 *    пометкой «только чтение», заявок и инструментов с ключом заявки нет;
 *  - описание и схема — из `tools/list` настоящего роута `/api/mcp`, вызов —
 *    `tools/call` того же роута (своих правил у страницы нет);
 *  - «не смог» не выдаётся за «зарегистрировано» (§4.0);
 *  - снятие — отменой `signal`, как велит спецификация.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { query, executeTool } = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  executeTool: vi.fn(async (_name: string, _args: unknown) => 'Погода на Камчатке: ясно, +3'),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query, connect: async () => ({ query, release: () => {} }) } }));
vi.mock('@/lib/kuzmich/core', () => ({ executeKuzmichTool: (name: string, args: unknown) => executeTool(name, args) }));

import { POST } from '@/app/api/mcp/route';
import {
  PUBLIC_MCP_TOOLS, PUBLIC_MCP_TOOL_NAMES, TOOL_ANNOTATIONS, WRITE_TOOL_NAMES, CHANGE_TOOL_NAMES, KEY_ARG_TOOL_NAMES,
} from '@/lib/mcp/public-tools';
import {
  WEBMCP_TOOL_NAMES, WEBMCP_MCP_PATH, getModelContext, registerVedarPageTools, toPageTool, toolResultText, callVedarTool,
  type ModelContextLike, type WebMcpToolDescriptor, type McpListedTool,
} from '@/lib/webmcp/page-tools';

type Init = RequestInit & { body?: string };
let ip = 0;

/** fetch страницы, который идёт в настоящий роут `/api/mcp`. */
const routeFetch = vi.fn(async (input: string, init: Init): Promise<Response> => {
  ip += 1;
  return POST(new NextRequest(`http://localhost${input}`, {
    method: init.method,
    headers: { ...(init.headers as Record<string, string>), 'x-real-ip': `10.77.0.${ip % 250}` },
    body: init.body,
  }));
});

function fakeContext(): ModelContextLike & { tools: WebMcpToolDescriptor[]; signals: (AbortSignal | undefined)[] } {
  const tools: WebMcpToolDescriptor[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  return {
    tools,
    signals,
    registerTool: (tool, opts) => { tools.push(tool); signals.push(opts?.signal); },
  };
}

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('какие инструменты страница отдаёт агенту', () => {
  it('каждый — в публичном MCP и помечен «только чтение»; заявок, отмены и ключа заявки нет', () => {
    for (const name of WEBMCP_TOOL_NAMES) {
      expect(PUBLIC_MCP_TOOL_NAMES.has(name), name).toBe(true);
      expect(TOOL_ANNOTATIONS[name]?.readOnlyHint, name).toBe(true);
      expect(WRITE_TOOL_NAMES.has(name), name).toBe(false);
      expect(CHANGE_TOOL_NAMES.has(name), name).toBe(false);
      expect(KEY_ARG_TOOL_NAMES.has(name), name).toBe(false);
    }
  });

  it('из настоящего списка публичного MCP получается ровно шесть инструментов страницы', () => {
    const page = PUBLIC_MCP_TOOLS
      .map((t) => toPageTool(t as McpListedTool, routeFetch))
      .filter((t): t is WebMcpToolDescriptor => t !== null);
    expect(page.map((t) => t.name).sort()).toEqual([...WEBMCP_TOOL_NAMES].sort());
    for (const t of page) {
      const src = PUBLIC_MCP_TOOLS.find((p) => p.name === t.name);
      expect(t.description).toBe(src?.description);
      expect(t.inputSchema).toBe(src?.inputSchema);
      expect(t.annotations).toEqual({ readOnlyHint: true });
    }
  });

  it('заявку страница не отдаёт, даже если сервер назовёт её «только чтение»', () => {
    const forged = { name: 'create_booking_request', description: 'x', inputSchema: {}, annotations: { readOnlyHint: true } };
    expect(toPageTool(forged, routeFetch)).toBeNull();
  });

  it('сервер снял пометку «только чтение» — инструмент страница не отдаёт', () => {
    expect(toPageTool({ name: 'get_tours', description: 'x', inputSchema: {}, annotations: { readOnlyHint: false } }, routeFetch)).toBeNull();
    expect(toPageTool({ name: 'get_tours', description: 'x', inputSchema: {} }, routeFetch)).toBeNull();
  });
});

describe('точка входа API', () => {
  const ctx = { registerTool: () => undefined };
  it('нынешняя document.modelContext первой, navigator — запасной путь, иначе null', () => {
    expect(getModelContext({ modelContext: ctx }, { modelContext: { registerTool: () => 1 } })).toBe(ctx);
    expect(getModelContext({}, { modelContext: ctx })).toBe(ctx);
    expect(getModelContext({}, {})).toBeNull();
    expect(getModelContext({ modelContext: { registerTool: 'нет' } }, {})).toBeNull();
    expect(getModelContext(undefined, undefined)).toBeNull();
  });
});

describe('регистрация через настоящий роут /api/mcp', () => {
  it('нет API — ни запроса к серверу, ни регистрации', async () => {
    const out = await registerVedarPageTools({ ctx: null, fetchFn: routeFetch, signal: new AbortController().signal });
    expect(out).toEqual({ kind: 'no_api' });
    expect(routeFetch).not.toHaveBeenCalled();
  });

  it('есть API — регистрирует шесть инструментов чтения с сигналом снятия; запрос без cookie', async () => {
    const ctx = fakeContext();
    const controller = new AbortController();
    const out = await registerVedarPageTools({ ctx, fetchFn: routeFetch, signal: controller.signal });
    expect(out.kind).toBe('registered');
    expect(ctx.tools.map((t) => t.name).sort()).toEqual([...WEBMCP_TOOL_NAMES].sort());
    expect(ctx.signals.every((s) => s === controller.signal)).toBe(true);
    const [path, init] = routeFetch.mock.calls[0];
    expect(path).toBe(WEBMCP_MCP_PATH);
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(String(init.body)).method).toBe('tools/list');
  });

  it('вызов инструмента агентом — tools/call того же роута, ответ — текст инструмента', async () => {
    const ctx = fakeContext();
    await registerVedarPageTools({ ctx, fetchFn: routeFetch, signal: new AbortController().signal });
    const weather = ctx.tools.find((t) => t.name === 'get_weather');
    const text = await weather?.execute({ place: 'Мутновский' });
    expect(text).toContain('Погода на Камчатке: ясно, +3');
    expect(executeTool).toHaveBeenCalledWith('get_weather', expect.objectContaining({ place: 'Мутновский' }));
    const body = JSON.parse(String(routeFetch.mock.calls.at(-1)?.[1].body));
    expect(body).toMatchObject({ method: 'tools/call', params: { name: 'get_weather' } });
  });

  it('страницу покинули до конца — «прервано», а не «зарегистрировано»', async () => {
    const ctx = fakeContext();
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); });
    const out = await registerVedarPageTools({ ctx, fetchFn, signal: controller.signal });
    expect(out).toEqual({ kind: 'aborted' });
    expect(ctx.tools).toHaveLength(0);
  });

  it('список не прочитался или пуст — «не смог» с причиной, без регистрации', async () => {
    for (const [res, reason] of [
      [jsonResponse(500, { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Внутренняя ошибка' } }), 'Внутренняя ошибка'],
      [new Response('<html>502</html>', { status: 502 }), 'HTTP 502'],
      [jsonResponse(200, { jsonrpc: '2.0', id: 1, result: {} }), 'без списка'],
      [jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'create_lead', description: 'x', inputSchema: {}, annotations: { readOnlyHint: false } }] } }), 'нет ни одного'],
    ] as const) {
      const ctx = fakeContext();
      const out = await registerVedarPageTools({ ctx, fetchFn: async () => res, signal: new AbortController().signal });
      expect(out.kind).toBe('failed');
      expect(out.kind === 'failed' ? out.reason : '').toContain(reason);
      expect(ctx.tools).toHaveLength(0);
    }
  });

  it('браузер отказал в регистрации — «не смог», а не «зарегистрировано»', async () => {
    const ctx: ModelContextLike = { registerTool: () => { throw new Error('InvalidStateError: tool exists'); } };
    const out = await registerVedarPageTools({ ctx, fetchFn: routeFetch, signal: new AbortController().signal });
    expect(out).toEqual({ kind: 'failed', reason: 'InvalidStateError: tool exists' });
  });
});

describe('ответ инструмента агенту', () => {
  it('текст частей отдаётся как есть, отказ инструмента — тоже (в нём сказано, что делать)', () => {
    expect(toolResultText({ content: [{ type: 'text', text: 'а' }, { type: 'image', data: 'x' }, { type: 'text', text: 'б' }] })).toBe('а\n\nб');
    expect(toolResultText({ content: [{ type: 'text', text: 'Тур не найден' }], isError: true })).toBe('Тур не найден');
  });

  it('пустой ответ — ошибка агенту, а не «ничего не найдено»', () => {
    expect(() => toolResultText({ content: [] })).toThrow('пустой ответ');
    expect(() => toolResultText(null)).toThrow('пустой ответ');
  });

  it('не объект на входе — пустые аргументы, а не исключение', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } }));
    await expect(callVedarTool(fetchFn, 'safety_status', 'строка')).resolves.toBe('ok');
    expect(JSON.parse(String((fetchFn.mock.calls[0] as unknown as [string, Init])[1].body)).params).toEqual({ name: 'safety_status', arguments: {} });
  });
});
