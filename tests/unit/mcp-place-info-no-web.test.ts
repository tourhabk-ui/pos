/**
 * get_place_info на публичном MCP не зовёт платный веб-поиск (проверка MCP 29.09).
 *
 * Шапка app/api/mcp/route.ts обещает: наружу не отдаётся то, что жжёт внешние
 * квоты (search_kamchatka — платный веб-поиск). А get_place_info при промахе
 * базы уходил в тот же searchWeb (Tavily/Brave) — анонимный вызов тратил
 * квоту, и чужой сниппет возвращался агенту без подписи, как справка из базы.
 *
 * В чате Кузьмича веб остаётся, но подписан как чужой текст.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('@/lib/kuzmich/place-info-tool', () => ({ placeInfoForKuzmich: vi.fn(async () => null) }));

import { executeKuzmichTool, WEB_NOT_BASE } from '@/lib/kuzmich/core';

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.TAVILY_API_KEY = 'test-key';
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ results: [{ title: 'Турагентство', content: 'Озеро Х — лучшее место' }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TAVILY_API_KEY;
});

describe('get_place_info: промах базы', () => {
  it('на MCP — честное «места нет», без запроса в платный поиск', async () => {
    const text = await executeKuzmichTool('get_place_info', { name: 'Озеро Х' }, { surface: 'mcp' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text).toMatch(/Места нет в справочнике платформы/);
  });

  it('в чате — веб остаётся, но подписан как не проверенный платформой', async () => {
    const text = await executeKuzmichTool('get_place_info', { name: 'Озеро Х' });
    expect(fetchMock).toHaveBeenCalled();
    expect(text.startsWith(WEB_NOT_BASE)).toBe(true);
    expect(text).toMatch(/Турагентство/);
  });
});

describe('роут MCP передаёт поверхность', () => {
  it('executeKuzmichTool зовётся с { surface: "mcp" }', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/api/mcp/route.ts', 'utf-8');
    expect(src).toMatch(/executeKuzmichTool\(name, validation\.args, \{ surface: 'mcp' \}\)/);
  });
});

// Проверка MCP 29.09: пустой ответ стража обещал «поищу через другие
// источники», а на MCP поиска нет — обещание действия, которого не будет.
describe('get_guardian_context: пусто — без обещания поиска на MCP', () => {
  it('MCP — «ничего нет» и 112; чат — прежняя подсказка модели', async () => {
    const mcp = await executeKuzmichTool('get_guardian_context', { place: 'Озеро Х' }, { surface: 'mcp' });
    expect(mcp).not.toMatch(/поискать/);
    expect(mcp).toMatch(/не значит, что там безопасно[\s\S]*112/);
    const chat = await executeKuzmichTool('get_guardian_context', { place: 'Озеро Х' });
    expect(chat).toMatch(/Попробую поискать/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
