/**
 * Сторож учёта расхода цикла инструментов Кузьмича (шаг 0 разбора «мозг
 * Кузьмича при росте каталога», 29.10).
 *
 * Повод. Четыре ноги `callToolsWaterfall` — главный путь ответа туристу —
 * разбирали в ответе провайдера только `choices`. В `llm_usage_log` не
 * попадало ни одной строки Кузьмича, перепись kuzmich-load-census называла
 * «верхней границей» корзину, куда его цикл не входил вовсе, а вес подсказки
 * был оценкой по формуле. Сравнивать модели и архитектуры памяти было не с чем.
 *
 * Второе: маркер кэша Anthropic уходил в OpenAI-совместимые ноги буквально,
 * строкой посреди правил Кузьмича.
 *
 * Сторож судит поведение: провайдер подменён (`fetch`), база подменена
 * (`pool.query`), и проверяется, что именно ушло в книги и в запрос.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));

import { parseProviderUsage, fullInputTokens, TOOLS_LOOP_AGENT_ID } from '@/lib/ai/provider-usage';
import { newLoopTiming, addTurnUsage, answerTokens } from '@/lib/kuzmich/answer-ceiling';
import { recordKuzmichAnswer } from '@/lib/kuzmich/answer-timing';

const MARKER = '<<<CACHE_BREAK>>>';
const SYSTEM = `Ты Кузьмич. Правила.\n\n${MARKER}\n\nСейчас 12:00.`;
const MESSAGES = [
  { role: 'system' as const, content: SYSTEM },
  { role: 'user' as const, content: 'туры к Толбачику' },
];

describe('разбор usage — чистая функция на образцах провайдеров', () => {
  it('OpenAI-совместимый с кэшем (OpenRouter, Qwen, xAI): кэш вычтен из входа и лежит отдельно', () => {
    const u = parseProviderUsage({
      prompt_tokens: 24_000, completion_tokens: 310, total_tokens: 24_310,
      prompt_tokens_details: { cached_tokens: 18_000 },
    });
    expect(u).toEqual({ promptTokens: 6_000, completionTokens: 310, cacheReadTokens: 18_000 });
    expect(fullInputTokens(u!)).toBe(24_000);
  });

  it('DeepSeek: попадания своими полями', () => {
    expect(parseProviderUsage({
      prompt_tokens: 23_000, completion_tokens: 200,
      prompt_cache_hit_tokens: 20_480, prompt_cache_miss_tokens: 2_520,
    })).toEqual({ promptTokens: 2_520, completionTokens: 200, cacheReadTokens: 20_480 });
  });

  it('DeepSeek без prompt_tokens: вход — сумма попаданий и промахов', () => {
    expect(parseProviderUsage({
      completion_tokens: 5, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 40,
    })).toEqual({ promptTokens: 40, completionTokens: 5, cacheReadTokens: 100 });
  });

  it('кэш не назван — null («не знаю»), а не ноль', () => {
    expect(parseProviderUsage({ prompt_tokens: 900, completion_tokens: 40 }))
      .toEqual({ promptTokens: 900, completionTokens: 40, cacheReadTokens: null });
  });

  it('назван ноль — это ноль: провайдер сказал, что кэша не было', () => {
    expect(parseProviderUsage({ prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 0 } })?.cacheReadTokens)
      .toBe(0);
  });

  it('кэша больше входа — числа противоречат: вход целиком, кэш «не знаю»', () => {
    expect(parseProviderUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 500 } }))
      .toEqual({ promptTokens: 100, completionTokens: 1, cacheReadTokens: null });
  });

  it('xAI: рассуждение вне completion_tokens прибавлено к выходу; у OpenAI оно уже внутри', () => {
    // Образец Grok: total = prompt + completion + reasoning (663 + 50 + 124 = 837).
    expect(parseProviderUsage({
      prompt_tokens: 663, completion_tokens: 50, total_tokens: 837,
      prompt_tokens_details: { cached_tokens: 654 },
      completion_tokens_details: { reasoning_tokens: 124 },
    })).toEqual({ promptTokens: 9, completionTokens: 174, cacheReadTokens: 654 });
    // OpenAI/DeepSeek: рассуждение внутри completion — total = prompt + completion.
    expect(parseProviderUsage({
      prompt_tokens: 1000, completion_tokens: 4000, total_tokens: 5000,
      completion_tokens_details: { reasoning_tokens: 4000 },
    })?.completionTokens).toBe(4000);
    // total не назван — прибавлять не по чему: выход как назван.
    expect(parseProviderUsage({
      prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 7 },
    })?.completionTokens).toBe(5);
  });

  it('нет usage, нет входа или мусор — null, а не строка с нулями', () => {
    expect(parseProviderUsage(undefined)).toBeNull();
    expect(parseProviderUsage(null)).toBeNull();
    expect(parseProviderUsage('usage')).toBeNull();
    expect(parseProviderUsage({ completion_tokens: 10 })).toBeNull();
    expect(parseProviderUsage({ prompt_tokens: -1, completion_tokens: 10 })).toBeNull();
    expect(parseProviderUsage({ prompt_tokens: 10 })).toBeNull();
  });
});

/** Ответ провайдера с инструментом и usage. */
function completion(model: string, usage: unknown): Response {
  return new Response(JSON.stringify({
    model,
    choices: [{ message: { content: 'Ответ', tool_calls: [] } }],
    ...(usage === undefined ? {} : { usage }),
  }), { status: 200 });
}

/** Подложенный провайдер: каталог моделей и чат. Запоминает тела запросов. */
function provider(model: string, usage: unknown) {
  const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: model }] }), { status: 200 });
    }
    bodies.push(JSON.parse(String(init?.body)));
    return completion(model, usage);
  });
  return { fetchMock, bodies };
}

/** Строки INSERT INTO llm_usage_log, которые увидела база. */
function usageInserts(): unknown[][] {
  return query.mock.calls
    .filter((c) => String(c[0]).includes('INSERT INTO llm_usage_log'))
    .map((c) => c[1] as unknown[]);
}

const DS_USAGE = { prompt_tokens: 23_000, completion_tokens: 200, prompt_cache_hit_tokens: 20_480, prompt_cache_miss_tokens: 2_520 };
const OAI_USAGE = { prompt_tokens: 24_000, completion_tokens: 310, prompt_tokens_details: { cached_tokens: 18_000 } };

type Leg = {
  name: string;
  model: string;
  usage: unknown;
  run: (p: typeof import('@/lib/ai/providers')) => Promise<unknown>;
  /** Ключ книг: вендор двоеточием, у OpenRouter — его слаг. */
  route: string;
  prompt: number; completion: number; cache: number | null;
};

const LEGS: Leg[] = [
  {
    name: 'DeepSeek', model: 'deepseek-chat', usage: DS_USAGE,
    run: (p) => p.callDeepSeekWithTools(MESSAGES, [], 'deepseek-chat'),
    route: 'deepseek:deepseek-chat', prompt: 2_520, completion: 200, cache: 20_480,
  },
  {
    name: 'Qwen', model: 'qwen-plus', usage: OAI_USAGE,
    run: (p) => p.callQwenWithTools(MESSAGES, []),
    route: 'qwen:qwen-plus', prompt: 6_000, completion: 310, cache: 18_000,
  },
  {
    name: 'xAI', model: 'grok-build-0.1', usage: { prompt_tokens: 900, completion_tokens: 40 },
    run: (p) => p.callXaiWithTools(MESSAGES, []),
    route: 'x-ai:grok-build-0.1', prompt: 900, completion: 40, cache: null,
  },
  {
    name: 'OpenRouter', model: 'openai/gpt-4o-mini', usage: OAI_USAGE,
    run: (p) => p.callOpenRouterWithTools(MESSAGES, []),
    route: 'openai/gpt-4o-mini', prompt: 6_000, completion: 310, cache: 18_000,
  },
];

describe('каждая нога цикла пишет расход в книги', () => {
  beforeEach(() => {
    vi.resetModules();
    query.mockReset();
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    // Прямой INSERT, а не отправка на прод: на раннере CI GITHUB_ACTIONS=true.
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test');
    vi.stubEnv('DASHSCOPE_API_KEY', 'sk-test');
    vi.stubEnv('QWEN_MODEL', 'qwen-plus');
    vi.stubEnv('XAI_API_KEY', 'xai-test');
    vi.stubEnv('XAI_FAST_MODEL', 'grok-build-0.1');
    vi.stubEnv('OR_API_KEY', 'sk-or-test');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const leg of LEGS) {
    it(`${leg.name}: строка с верными числами, agent_id kuzmich, кэш в своей колонке`, async () => {
      const { fetchMock } = provider(leg.model, leg.usage);
      vi.stubGlobal('fetch', fetchMock);
      const providers = await import('@/lib/ai/providers');

      const result = await leg.run(providers) as { content: string; usage: unknown } | null;
      expect(result?.content).toBe('Ответ');
      await vi.waitFor(() => expect(usageInserts()).toHaveLength(1));

      // (route, prompt, completion, total, cost, basis, agent_id, cache_read)
      const [route, prompt, completionTokens, total, , , agentId, cacheRead] = usageInserts()[0];
      expect(route).toBe(leg.route);
      expect(prompt).toBe(leg.prompt);
      expect(completionTokens).toBe(leg.completion);
      expect(total).toBe(leg.prompt + leg.completion);
      expect(agentId).toBe(TOOLS_LOOP_AGENT_ID);
      expect(cacheRead).toBe(leg.cache);
      // Те же числа — ходу цикла, для замера ответа.
      expect(result?.usage).toEqual({ promptTokens: leg.prompt, completionTokens: leg.completion, cacheReadTokens: leg.cache });
    });

    it(`${leg.name}: маркер кэша не уходит провайдеру текстом`, async () => {
      const { fetchMock, bodies } = provider(leg.model, leg.usage);
      vi.stubGlobal('fetch', fetchMock);
      const providers = await import('@/lib/ai/providers');

      await leg.run(providers);
      expect(bodies).toHaveLength(1);
      const system = bodies[0].messages.find((m) => m.role === 'system')!.content;
      expect(system).not.toContain(MARKER);
      // Обе части подсказки на месте — вырезан только маркер.
      expect(system).toBe('Ты Кузьмич. Правила.\n\nСейчас 12:00.');
      expect(bodies[0].messages[1]).toEqual(MESSAGES[1]);
    });
  }

  it('DeepSeek с кэшем: цена — оценка сверху по голому имени модели, не NULL', async () => {
    const { fetchMock } = provider('deepseek-chat', DS_USAGE);
    vi.stubGlobal('fetch', fetchMock);
    const providers = await import('@/lib/ai/providers');

    await providers.callDeepSeekWithTools(MESSAGES, [], 'deepseek-chat');
    await vi.waitFor(() => expect(usageInserts()).toHaveLength(1));
    const [, , , , cost, basis] = usageInserts()[0];
    // Прочитанное — по полной цене входа: (2 520 + 20 480 + 200) × 0.0005 / 1000.
    expect(cost as number).toBeCloseTo((23_200 * 0.0005) / 1000, 10);
    expect(basis).toBe('cost_table_fallback_cache_upper_bound');
  });

  it('DeepSeek без кэша: та же цена, что у текстового пути, без пометки', async () => {
    const { fetchMock } = provider('deepseek-chat', { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000 });
    vi.stubGlobal('fetch', fetchMock);
    const providers = await import('@/lib/ai/providers');

    await providers.callDeepSeekWithTools(MESSAGES, [], 'deepseek-chat');
    await vi.waitFor(() => expect(usageInserts()).toHaveLength(1));
    const [, , , , cost, basis] = usageInserts()[0];
    expect(cost as number).toBeCloseTo((1_100 * 0.0005) / 1000, 10);
    expect(basis).toBe('cost_table_fallback');
  });

  it('запись в кэш у чужого вендора — цена «не знаем»: граница сверху есть только у чтения', async () => {
    const providers = await import('@/lib/ai/providers');
    expect(await providers.resolveCostWithCache('deepseek:deepseek-chat', 100, 10, { creation: 50, read: 0 }))
      .toEqual({ cost: null, basis: 'unknown' });
    // Неизвестная модель — и граница неизвестна.
    expect(await providers.resolveCostWithCache('othervendor:m', 100, 10, { creation: null, read: 500 }))
      .toEqual({ cost: null, basis: 'unknown' });
  });

  it('водопад отдаёт расход и отвергнутой ноги: пустой ответ DeepSeek оплачен и виден ходу', async () => {
    vi.stubEnv('DEEPSEEK_MODEL', 'deepseek-chat');
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen-plus' }] }), { status: 200 });
      if (u.includes('deepseek')) {
        return new Response(JSON.stringify({ model: 'deepseek-chat', choices: [], usage: DS_USAGE }), { status: 200 });
      }
      return completion('qwen-plus', OAI_USAGE);
    });
    vi.stubGlobal('fetch', fetchMock);
    const providers = await import('@/lib/ai/providers');

    const turn: Array<import('@/lib/ai/provider-usage').ParsedUsage | null> = [];
    const r = await providers.callToolsWaterfall(MESSAGES, [], turn);
    expect(r?.provider).toBe('qwen');
    expect(turn).toEqual([
      { promptTokens: 2_520, completionTokens: 200, cacheReadTokens: 20_480 },
      { promptTokens: 6_000, completionTokens: 310, cacheReadTokens: 18_000 },
    ]);
    // Книги видят обе строки — замер хода теперь сходится с ними.
    await vi.waitFor(() => expect(usageInserts()).toHaveLength(2));
  });

  it('запасной водопад: маркер кэша не уходит текстом ни одной не-Anthropic ноге', async () => {
    vi.stubEnv('DEEPSEEK_MODEL', 'deepseek-chat');
    vi.stubEnv('GROQ_API_KEY', 'gsk-test');
    vi.stubEnv('MISTRAL_API_KEY', 'mistral-test');
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), { status: 200 });
      if (init?.body) bodies.push(String(init.body));
      return new Response(JSON.stringify({ model: 'm', choices: [{ message: { content: 'Ответ' }, finish_reason: 'stop' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const providers = await import('@/lib/ai/providers');

    const out = await providers.callAIWaterfallDetailed(MESSAGES);
    expect(out.failed).toBe(false);
    const chat = bodies.filter((b) => b.includes('"messages"'));
    expect(chat.length).toBeGreaterThan(0);
    for (const b of chat) {
      expect(b).not.toContain(MARKER);
      expect(b).toContain('Ты Кузьмич. Правила.');
    }
  });

  it('внутри учёта агента (эвал) строка несёт его имя, а не kuzmich', async () => {
    const { fetchMock } = provider('deepseek-chat', DS_USAGE);
    vi.stubGlobal('fetch', fetchMock);
    const providers = await import('@/lib/ai/providers');
    const { runWithUsageTracking } = await import('@/lib/ai/usage-context');

    await runWithUsageTracking('eval-kuzmich', () => providers.callDeepSeekWithTools(MESSAGES, [], 'deepseek-chat'));
    await vi.waitFor(() => expect(usageInserts()).toHaveLength(1));
    expect(usageInserts()[0][6]).toBe('eval-kuzmich');
  });

  it('водопад отдаёт расход ответившей ноги вместе с ответом', async () => {
    const { fetchMock } = provider('deepseek-chat', DS_USAGE);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('DEEPSEEK_MODEL', 'deepseek-chat');
    const providers = await import('@/lib/ai/providers');

    const r = await providers.callToolsWaterfall(MESSAGES, []);
    expect(r?.provider).toBe('deepseek');
    expect(r?.usage).toEqual({ promptTokens: 2_520, completionTokens: 200, cacheReadTokens: 20_480 });
  });

  it('usage нет — строки с нулями нет, «не учтено» сказано в лог, ответ на месте', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fetchMock } = provider('deepseek-chat', undefined);
    vi.stubGlobal('fetch', fetchMock);
    const providers = await import('@/lib/ai/providers');

    const r = await providers.callDeepSeekWithTools(MESSAGES, [], 'deepseek-chat');
    expect(r?.content).toBe('Ответ');
    expect(r?.usage).toBeNull();
    expect(usageInserts()).toHaveLength(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('deepseek:tools') && String(c[0]).includes('usage'))).toBe(true);
  });

  it('отказ записи учёта не роняет ответ и пишется в лог с SQLSTATE', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    query.mockRejectedValue(Object.assign(new Error('column "cache_read_tokens" does not exist'), { code: '42703' }));
    const { fetchMock } = provider('deepseek-chat', DS_USAGE);
    vi.stubGlobal('fetch', fetchMock);
    const providers = await import('@/lib/ai/providers');

    const r = await providers.callDeepSeekWithTools(MESSAGES, [], 'deepseek-chat');
    expect(r?.content).toBe('Ответ');
    await vi.waitFor(() => expect(error.mock.calls.some((c) => c.join(' ').includes('SQLSTATE 42703'))).toBe(true));
    const line = error.mock.calls.find((c) => c.join(' ').includes('SQLSTATE 42703'))!.join(' ');
    expect(line).toContain('[llm-usage]');
    // Ни слова реплики туриста — только модель и причина.
    expect(line).not.toContain('Толбачик');
  });
});

describe('расход ответа — в замер kuzmich_answer, по ходам', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it('суммы по ходам, самый тяжёлый ход, кэш только там, где назван; ход без usage — «не знаю»', () => {
    const t = newLoopTiming();
    expect(answerTokens(t)).toBeNull();
    addTurnUsage(t, { promptTokens: 2_000, completionTokens: 100, cacheReadTokens: 20_000 });
    addTurnUsage(t, { promptTokens: 26_000, completionTokens: 300, cacheReadTokens: null });
    addTurnUsage(t, null);
    expect(answerTokens(t)).toEqual({
      reportedCalls: 2, unreportedCalls: 1,
      inputTokens: 48_000, maxCallInputTokens: 26_000, completionTokens: 400,
      cacheReadTokens: 20_000, cacheReportedCalls: 1,
    });
  });

  it('ответил запасной путь после ходов цикла — сумма помечена неполной', () => {
    const t = newLoopTiming();
    addTurnUsage(t, { promptTokens: 10_000, completionTokens: 0, cacheReadTokens: null });
    expect(answerTokens(t, { answeredOutsideLoop: true })).toMatchObject({ reportedCalls: 1, unreportedCalls: 1, inputTokens: 10_000 });
    expect(answerTokens(t)).toMatchObject({ reportedCalls: 1, unreportedCalls: 0 });
    // Цикл не звался вовсе — расхода нет, пометка не делает из него запись.
    expect(answerTokens(newLoopTiming(), { answeredOutsideLoop: true })).toBeNull();
  });

  it('замер пишет числа; без расхода ключей нет вовсе, а не нули', async () => {
    const t = newLoopTiming();
    addTurnUsage(t, { promptTokens: 1_000, completionTokens: 50, cacheReadTokens: null });
    await recordKuzmichAnswer({
      surface: 'telegram', elapsedMs: 900, turns: 1, toolRounds: 0, path: 'tools',
      provider: 'deepseek', ceilingHit: false, tokens: answerTokens(t),
    });
    await recordKuzmichAnswer({
      surface: 'widget', elapsedMs: 900, turns: null, toolRounds: null, path: 'single',
      provider: null, ceilingHit: false,
    });
    const [withTokens, without] = query.mock.calls.map((c) => JSON.parse(String((c[1] as unknown[])[2])) as Record<string, unknown>);
    expect(withTokens).toMatchObject({
      input_tokens: 1_000, max_call_input_tokens: 1_000, completion_tokens: 50,
      cache_read_tokens: null, usage_calls: 1, usage_unreported_calls: 0,
    });
    for (const key of ['input_tokens', 'cache_read_tokens', 'usage_calls']) {
      expect(without, key).not.toHaveProperty(key);
    }
  });
});
