/**
 * Чей расход и полон ли замер (ревью шага 0 разбора «мозг Кузьмича», 29.10).
 *
 * 1. Эвал и red-team Кузьмича ходят тем же циклом инструментов, что живой
 *    Кузьмич, а ноги цикла вне учёта агента пишут строку книг от имени
 *    'kuzmich'. Без `runWithUsageTracking` в роуте сотня вопросов эвала легла
 *    бы в замер «до» по поверхностям и провайдерам. Сторож — вызов роута, в
 *    котором прогон доходит до настоящей ноги с подложенным провайдером: что
 *    стоит в INSERT llm_usage_log.
 * 2. Ход цикла, где одна нога ответила пустым (но оплаченным) ответом, а
 *    другая — ответом: замер ответа видит оба вызова, как книги.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  waterfall: vi.fn(),
  logAgentRun: vi.fn(async () => undefined),
}));

vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => h.query(...a) } }));
vi.mock('@/lib/agents/run-logger', () => ({ logAgentRun: h.logAgentRun }));
vi.mock('@/lib/agents/eval/live-questions', () => ({
  sampleLiveQuestions: async () => [{ id: 'live-1', category: 'live', question: 'Как добраться до Мутновского?' }],
}));

const MESSAGES = [
  { role: 'system' as const, content: 'Ты Кузьмич.' },
  { role: 'user' as const, content: 'туры к Толбачику' },
];
const DS_USAGE = { prompt_tokens: 1_000, completion_tokens: 50 };

/** Прогон эвала и red-team подменён: каждый доходит до настоящей ноги DeepSeek. */
async function oneLegCall(): Promise<void> {
  const providers = await vi.importActual<typeof import('@/lib/ai/providers')>('@/lib/ai/providers');
  await providers.callDeepSeekWithTools(MESSAGES, [], 'deepseek-chat');
}

vi.mock('@/lib/agents/eval/kuzmich-faithfulness', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/agents/eval/kuzmich-faithfulness')>();
  return {
    ...orig,
    runKuzmichFaithfulnessEval: async () => {
      await oneLegCall();
      return { ...orig.summarizeFaithfulness([]), alerts_sent: false };
    },
  };
});
vi.mock('@/lib/agents/eval/kuzmich-redteam', () => ({
  runKuzmichRedteamEval: async () => {
    await oneLegCall();
    return { asked: 1, evaluated: 1, passed: 1, failed_core: 0, failed_stretch: 0, unevaluated: 0, alerts_sent: false, cases: [] };
  },
}));

function usageAgentIds(): unknown[] {
  return h.query.mock.calls
    .filter((c) => String(c[0]).includes('INSERT INTO llm_usage_log'))
    .map((c) => (c[1] as unknown[])[6]);
}

function stubProvider(): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    model: 'deepseek-chat',
    choices: [{ message: { content: 'Ответ', tool_calls: [] } }],
    usage: DS_USAGE,
  }), { status: 200 })));
}

describe('эвал и red-team пишут расход под своим именем, а не как живой Кузьмич', () => {
  beforeEach(() => {
    h.query.mockReset();
    h.query.mockResolvedValue({ rows: [], rowCount: 1 });
    vi.stubEnv('CRON_SECRET', 'test-secret');
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test');
    stubProvider();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const req = async (path: string) => {
    const { NextRequest } = await import('next/server');
    return new NextRequest(`http://localhost${path}`, { headers: { authorization: 'Bearer test-secret' } });
  };

  for (const [query, agent] of [
    ['', 'kuzmich-eval'],
    ['?set=commercial', 'kuzmich-eval-commercial'],
    ['?source=live', 'kuzmich-eval-live'],
  ] as const) {
    it(`kuzmich-eval${query} → ${agent}`, async () => {
      const { GET } = await import('@/app/api/cron/kuzmich-eval/route');
      const res = await GET(await req(`/api/cron/kuzmich-eval${query}`));
      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(usageAgentIds()).toHaveLength(1));
      expect(usageAgentIds()).toEqual([agent]);
    });
  }

  it('kuzmich-redteam → kuzmich-redteam', async () => {
    const { GET } = await import('@/app/api/cron/kuzmich-redteam/route');
    const res = await GET(await req('/api/cron/kuzmich-redteam'));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(usageAgentIds()).toHaveLength(1));
    expect(usageAgentIds()).toEqual(['kuzmich-redteam']);
  });

  it('та же нога вне учёта агента — живой Кузьмич', async () => {
    await oneLegCall();
    await vi.waitFor(() => expect(usageAgentIds()).toEqual(['kuzmich']));
  });
});

describe('ход цикла: оплаченный отказ ноги — в замере ответа, как в книгах', () => {
  beforeEach(() => {
    h.query.mockReset();
    h.query.mockResolvedValue({ rows: [], rowCount: 1 });
    h.waterfall.mockReset();
  });

  it('пустой ответ одной ноги и ответ другой — два учтённых вызова', async () => {
    vi.doMock('@/lib/ai/providers', async (importOriginal) => {
      const orig = await importOriginal<typeof import('@/lib/ai/providers')>();
      return { ...orig, callToolsWaterfall: (...a: unknown[]) => h.waterfall(...a) };
    });
    vi.resetModules();
    // Водопад кладёт в массив хода расход обеих ног, как это делает настоящий.
    h.waterfall.mockImplementation(async (_m: unknown, _t: unknown, turn?: unknown[]) => {
      turn?.push({ promptTokens: 9_000, completionTokens: 0, cacheReadTokens: 1_000 });
      turn?.push({ promptTokens: 4_000, completionTokens: 120, cacheReadTokens: null });
      return { content: 'Ответ.', tool_calls: null, provider: 'qwen', usage: { promptTokens: 4_000, completionTokens: 120, cacheReadTokens: null } };
    });
    const { aiChatAgentLoop } = await import('@/lib/kuzmich/core');
    const { newLoopTiming, answerTokens } = await import('@/lib/kuzmich/answer-ceiling');

    const timing = newLoopTiming();
    const answer = await aiChatAgentLoop('Туры на Толбачик?', 'система', [], [], [], {}, timing);
    expect(answer).toBe('Ответ.');
    expect(answerTokens(timing)).toMatchObject({
      reportedCalls: 2, unreportedCalls: 0, inputTokens: 14_000, maxCallInputTokens: 10_000, completionTokens: 120,
    });
    vi.doUnmock('@/lib/ai/providers');
  });

  it('все ноги отказали, но одна была оплачена — расход не теряется', async () => {
    vi.doMock('@/lib/ai/providers', async (importOriginal) => {
      const orig = await importOriginal<typeof import('@/lib/ai/providers')>();
      return { ...orig, callToolsWaterfall: (...a: unknown[]) => h.waterfall(...a) };
    });
    vi.resetModules();
    h.waterfall.mockImplementation(async (_m: unknown, _t: unknown, turn?: unknown[]) => {
      turn?.push({ promptTokens: 7_000, completionTokens: 0, cacheReadTokens: null });
      return null;
    });
    const { aiChatAgentLoop } = await import('@/lib/kuzmich/core');
    const { newLoopTiming, answerTokens } = await import('@/lib/kuzmich/answer-ceiling');

    const timing = newLoopTiming();
    expect(await aiChatAgentLoop('Туры на Толбачик?', 'система', [], [], [], {}, timing)).toBeNull();
    expect(answerTokens(timing)).toMatchObject({ reportedCalls: 1, inputTokens: 7_000 });
    vi.doUnmock('@/lib/ai/providers');
  });
});
