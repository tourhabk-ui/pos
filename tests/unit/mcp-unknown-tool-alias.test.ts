/**
 * Неизвестный инструмент (21.11): живое имя под чужим написанием исполняется,
 * пробы — нет; отказ называет, куда класть имя, и не путает фразу с именем.
 *
 * Панель владельца 20.11: 18 запросов «не-идентификатор» за день,
 * evyai_mcp_check_probe 4, no_such_tool 1.
 */
import { describe, it, expect } from 'vitest';
import { resolveToolAlias, unknownToolResponse } from '@/lib/mcp/unknown-tool';
import { PUBLIC_MCP_TOOL_NAMES } from '@/lib/mcp/public-tools';

describe('resolveToolAlias', () => {
  it('живое имя — как есть', () => {
    for (const n of PUBLIC_MCP_TOOL_NAMES) expect(resolveToolAlias(n)).toBe(n);
  });

  it('префикс сервера, дефис, пробел, регистр, верблюд — тот же инструмент', () => {
    expect(resolveToolAlias('vedar:get_tours')).toBe('get_tours');
    expect(resolveToolAlias('vedar-kamchatka/get_tours')).toBe('get_tours');
    expect(resolveToolAlias('mcp__vedar__get_tours')).toBe('get_tours');
    expect(resolveToolAlias('functions.get_weather')).toBe('get_weather');
    expect(resolveToolAlias('get-tours')).toBe('get_tours');
    expect(resolveToolAlias('Get Tours')).toBe('get_tours');
    expect(resolveToolAlias('getTourDetails')).toBe('get_tour_details');
    expect(resolveToolAlias('  create_lead  ')).toBe('create_lead');
  });

  it('пробы и похожие, но другие имена — не алиас', () => {
    for (const n of ['evyai_mcp_check_probe', 'no_such_tool', 'get_tour', 'tours', 'search tours in August', '', 'vedar:', 'x'.repeat(100)]) {
      expect(resolveToolAlias(n), n).toBeNull();
    }
  });
});

describe('unknownToolResponse', () => {
  it('пустое имя — «имени нет» и куда его класть, а не «Unknown tool: .»', () => {
    const r = unknownToolResponse('');
    expect(r.message).toMatch(/^Tool name is missing: tools\/call needs params\.name/);
    expect(r.message).not.toContain('Unknown tool: .');
    expect(r.data.available).toContain('create_lead');
  });

  it('фраза вместо имени — подсказка, что нужно точное имя, и ближайшее по словам', () => {
    const r = unknownToolResponse('get tour details please');
    expect(r.message).toContain('not a phrase');
    expect(r.data.suggestion).toBe('get_tour_details');
  });

  it('проба — обычный отказ со списком имён, без «фразы»', () => {
    const r = unknownToolResponse('evyai_mcp_check_probe');
    expect(r.message).toMatch(/^Unknown tool: evyai_mcp_check_probe\./);
    expect(r.message).not.toContain('not a phrase');
    expect(r.message).toContain('Available tools: ');
  });
});

describe('resolveToolAliasDetailed — род алиаса', () => {
  it('живое имя без рода; префикс и написание различаются', async () => {
    const { resolveToolAliasDetailed } = await import('@/lib/mcp/unknown-tool');
    expect(resolveToolAliasDetailed('get_tours')).toEqual({ name: 'get_tours', kind: null });
    expect(resolveToolAliasDetailed('vedar:get_tours')).toEqual({ name: 'get_tours', kind: 'префикс' });
    expect(resolveToolAliasDetailed('mcp__vedar__get_tours')).toEqual({ name: 'get_tours', kind: 'префикс' });
    expect(resolveToolAliasDetailed('getTours')).toEqual({ name: 'get_tours', kind: 'написание' });
    expect(resolveToolAliasDetailed('no_such_tool')).toBeNull();
  });
});
