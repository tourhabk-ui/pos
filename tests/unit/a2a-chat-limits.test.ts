/**
 * Пределы разговора чужого агента — размер вопроса, история, веб-поиск и число
 * вызовов инструментов за ход (проверка безопасности ИИ-части 26.11, слово
 * владельца «чини Карт бланш»).
 *
 * До этого дня вопрос агента шёл в модель любой длины (до 16 частей по 8000
 * знаков) с историей разговора без обрезки; агент получал платный веб-поиск
 * (Tavily/Brave), которого нет даже на MCP; а модель могла за ход позвать
 * инструменты сколько угодно раз.
 *
 * Здесь — настоящий answerAgentMessage и цикл инструментов (подменён только
 * провайдер): что увидела модель и что исполнилось. Дневной предел на адрес и
 * доля бюджета — tests/unit/a2a-chat-door-limits.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { waterfall } = vi.hoisted(() => ({ waterfall: vi.fn() }));
vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/ai/providers')>();
  return { ...orig, callToolsWaterfall: (...a: unknown[]) => waterfall(...a) };
});
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));

import { answerAgentMessage, A2A_TOO_LONG_TEXT } from '@/lib/a2a/chat';
import { executeKuzmichTool, AGENT_NO_WEB_SEARCH } from '@/lib/kuzmich/core';
import { runTurnTools, MAX_TOOL_CALLS_PER_TURN } from '@/lib/kuzmich/tool-loop';
import { MAX_MESSAGE_CHARS, MAX_HISTORY_ITEMS_USED, MAX_HISTORY_ITEM_CHARS } from '@/lib/ai/anon-chat-guard';

type Msg = { role: string; content: string | null };
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  waterfall.mockReset();
  waterfall.mockResolvedValue({ content: 'Ответ по данным Ведара.', provider: 'test' });
  fetchSpy = vi.fn().mockRejectedValue(new Error('сеть в тесте закрыта'));
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubEnv('TAVILY_API_KEY', 'tvly-test');
  vi.stubEnv('BRAVE_API_KEY', 'brave-test');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('размер вопроса и история', () => {
  it(`вопрос длиннее ${MAX_MESSAGE_CHARS} знаков — отказ too_long без модели`, async () => {
    const out = await answerAgentMessage('туры '.repeat(MAX_MESSAGE_CHARS), []);
    expect(out).toEqual({ ok: false, text: A2A_TOO_LONG_TEXT, rejected: true, reason: 'too_long' });
    expect(waterfall).not.toHaveBeenCalled();
  });

  it('история разговора доходит до модели под потолками гостя', async () => {
    const history = Array.from({ length: 16 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `реплика ${i} ` + 'х'.repeat(5000),
    }));
    await answerAgentMessage('а погода там?', history);
    const msgs = waterfall.mock.calls[0]![0] as Msg[];
    const past = msgs.filter((m) => m.role !== 'system' && m.content !== 'а погода там?');
    expect(past.length).toBeLessThanOrEqual(MAX_HISTORY_ITEMS_USED);
    for (const m of past) expect((m.content ?? '').length).toBeLessThanOrEqual(MAX_HISTORY_ITEM_CHARS + 200);
    // Последние реплики остаются, первые уходят.
    expect(past.some((m) => (m.content ?? '').includes('реплика 15'))).toBe(true);
    expect(past.some((m) => (m.content ?? '').includes('реплика 0 '))).toBe(false);
  });
});

describe('веб-поиск — не для внешних агентов', () => {
  it('search_kamchatka у агента: поиска нет, сеть не зовётся', async () => {
    const out = await executeKuzmichTool('search_kamchatka', { query: 'цены на вертолёт' }, { agent: true });
    expect(out).toBe(AGENT_NO_WEB_SEARCH);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('get_place_info у агента: места нет в базе — веб не спрашивается', async () => {
    const out = await executeKuzmichTool('get_place_info', { name: 'Несуществующее урочище Тестовое' }, { agent: true });
    expect(out).not.toMatch(/Tavily|Brave/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe(`не больше ${MAX_TOOL_CALLS_PER_TURN} вызовов инструментов за ход`, () => {
  it('лишние вызовы не исполняются и получают объяснение, порядок сохранён', async () => {
    const calls = Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 3 }, (_, i) => ({
      id: `c${i}`, type: 'function' as const,
      function: { name: 'search_kamchatka', arguments: JSON.stringify({ query: `запрос ${i}` }) },
    }));
    const exec = vi.fn(async () => 'данные');
    const out = await runTurnTools(calls, new Set(), exec);
    expect(exec).toHaveBeenCalledTimes(MAX_TOOL_CALLS_PER_TURN);
    expect(out.map((o) => o.id)).toEqual(calls.map((c) => c.id));
    const over = out.filter((o) => o.skipped === 'over_limit');
    expect(over).toHaveLength(3);
    for (const o of over) {
      expect(o.executed).toBe(false);
      expect(o.content).toMatch(new RegExp(`не больше ${MAX_TOOL_CALLS_PER_TURN} вызовов`));
    }
  });
});
