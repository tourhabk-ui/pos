/**
 * /api/mcp — один мозг, два протокола.
 *
 * Публичный MCP-сервер обязан отдавать инструменты из реестра Кузьмича
 * (минус явные исключения), а не держать параллельный набор со своим SQL:
 * параллельный набор уже расходился с Кузьмичом однажды (4 инструмента
 * против 9, чтение agent_route_knowledge напрямую, без безопасности).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { TOOL_REGISTRY } from '@/lib/kuzmich/tool-schemas';

vi.mock('@/lib/kuzmich/core', () => ({
  executeKuzmichTool: vi.fn(async (name: string) => `executed:${name}`),
}));

import { GET, POST } from '@/app/api/mcp/route';
import { executeKuzmichTool } from '@/lib/kuzmich/core';

const EXCLUDED = ['search_kamchatka', 'search_taaft'];

function rpc(method: string, params?: Record<string, unknown>) {
  return POST(
    new NextRequest('http://localhost/api/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  );
}

beforeEach(() => {
  vi.mocked(executeKuzmichTool).mockClear();
});

describe('/api/mcp — паритет с реестром Кузьмича', () => {
  it('tools/list == реестр Кузьмича минус исключения, схемы на месте', async () => {
    const res = await rpc('tools/list');
    const json = await res.json();
    const tools = json.result.tools as Array<{ name: string; description: string; inputSchema: unknown }>;

    const expected = Object.keys(TOOL_REGISTRY).filter((n) => !EXCLUDED.includes(n)).sort();
    expect(tools.map((t) => t.name).sort()).toEqual(expected);
    // Реестр не должен схлопнуться до старых 4 инструментов
    expect(tools.length).toBeGreaterThanOrEqual(7);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeTruthy();
    }
  });

  it('GET-инфо отдаёт тот же список', async () => {
    const res = await GET();
    const json = await res.json();
    const names = (json.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain('search_kamchatka');
    expect(names).toContain('get_guardian_context');
  });

  it('tools/call делегирует исполнителю Кузьмича', async () => {
    const res = await rpc('tools/call', { name: 'get_weather', arguments: {} });
    const json = await res.json();
    expect(json.result.isError).toBeUndefined();
    expect(json.result.content[0].text).toBe('executed:get_weather');
    expect(executeKuzmichTool).toHaveBeenCalledWith('get_weather', {});
  });

  it('аргументы проходят Zod-коэрсию Кузьмича (число → строка, trim)', async () => {
    const res = await rpc('tools/call', { name: 'get_place_info', arguments: { name: 42 } });
    const json = await res.json();
    expect(json.result.isError).toBeUndefined();
    expect(executeKuzmichTool).toHaveBeenCalledWith('get_place_info', { name: '42' });
  });

  it('невалидные аргументы — isError, исполнитель не зовётся', async () => {
    const res = await rpc('tools/call', { name: 'get_place_info', arguments: {} });
    const json = await res.json();
    expect(json.result.isError).toBe(true);
    expect(executeKuzmichTool).not.toHaveBeenCalled();
  });

  it('исключённые и неизвестные инструменты не исполняются', async () => {
    for (const name of [...EXCLUDED, 'no_such_tool']) {
      const res = await rpc('tools/call', { name, arguments: { query: 'test', task: 'test' } });
      const json = await res.json();
      expect(json.result.isError, name).toBe(true);
    }
    expect(executeKuzmichTool).not.toHaveBeenCalled();
  });

  it('initialize-рукопожатие живо', async () => {
    const res = await rpc('initialize');
    const json = await res.json();
    expect(json.result.protocolVersion).toBe('2024-11-05');
  });
});

describe('/api/mcp — структурно нет своего движка', () => {
  it('роут не содержит SQL и не читает agent_route_knowledge', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('app/api/mcp/route.ts', 'utf8');
    expect(src).not.toMatch(/agent_route_knowledge/);
    expect(src).not.toMatch(/\b(SELECT|FROM|JOIN)\b/);
    expect(src).toMatch(/TOOL_REGISTRY/);
    expect(src).toMatch(/executeKuzmichTool/);
  });
});
