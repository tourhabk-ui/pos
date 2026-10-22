/**
 * Проба своей модели на своём железе (lib/ai/local-model-probe.ts).
 * Всё — вызовом на граничных данных, без чтения исходника.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  readLocalModelConfig, isOwnHardwareUrl, readOnlyToolsForProbe, runProbeTurn,
  contextLooksTruncated, summarizeProbe, parseMcpBody,
  type LocalModelConfig, type TurnResult, type OpenAiTool,
} from '@/lib/ai/local-model-probe';
import { PUBLIC_MCP_TOOLS, WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';
import { LLM_EGRESS_FILES } from '@/lib/agents/compliance/provider-registry';
import { isProbeClient } from '@/lib/mcp/probe-clients';
import { LOCAL_PROBE_CLIENT } from '@/lib/ai/local-model-probe';

const CFG: LocalModelConfig = {
  baseUrl: 'http://127.0.0.1:11434/v1', model: 'm', apiKey: null, timeoutMs: 5000, noThink: true,
};
const TOOLS: OpenAiTool[] = [
  { type: 'function', function: { name: 'get_tours', description: 'туры', parameters: { type: 'object', properties: {} } } },
];
const LONG_SYSTEM = 'с'.repeat(600);

function reply(message: Record<string, unknown>, finish = 'stop', usage = { prompt_tokens: 300, completion_tokens: 20 }) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: finish, message }], usage }), { status: 200 });
}

/** Подставной сервер модели: отдаёт ответы по очереди и запоминает тела запросов. */
function fakeServer(responses: Array<Response | (() => Response)>) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = responses.shift();
    if (!next) throw new Error('лишний запрос');
    return typeof next === 'function' ? next() : next;
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

describe('адрес модели — только своё железо', () => {
  it.each([
    ['http://127.0.0.1:11434/v1', true],
    ['http://localhost:1234/v1', true],
    ['http://[::1]:11434/v1', true],
    ['http://192.168.1.20:11434/v1', true],
    ['http://10.0.0.5:8000/v1', true],
    ['http://172.16.0.2/v1', true],
    ['http://172.31.255.1/v1', true],
    ['http://gpu-box.local:11434/v1', true],
    ['http://172.32.0.1/v1', false],
    ['https://api.deepseek.com/v1', false],
    ['https://8.8.8.8/v1', false],
    ['http://192.168.1.300/v1', false],
    ['ftp://127.0.0.1/v1', false],
    ['не адрес', false],
  ])('%s → %s', (url, ok) => {
    expect(isOwnHardwareUrl(url)).toBe(ok);
  });

  it('без модели — отказ словами, а не прогон «в никуда»', () => {
    const r = readLocalModelConfig({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/LOCAL_LLM_MODEL/);
  });

  it('удалённый адрес не принимается: он был бы приёмником мимо реестра D2', () => {
    const r = readLocalModelConfig({ LOCAL_LLM_MODEL: 'x', LOCAL_LLM_URL: 'https://api.example.com/v1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/не своё железо/);
  });

  it('по умолчанию — Ollama на этом компьютере, размышление просим выключить', () => {
    const r = readLocalModelConfig({ LOCAL_LLM_MODEL: 'qwen' });
    expect(r).toEqual({ ok: true, cfg: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen', apiKey: null, timeoutMs: 180_000, noThink: true } });
    const t = readLocalModelConfig({ LOCAL_LLM_MODEL: 'qwen', LOCAL_LLM_THINK: '1', LOCAL_LLM_URL: 'http://192.168.0.7:1234/v1/' });
    expect(t.ok && t.cfg.noThink).toBe(false);
    expect(t.ok && t.cfg.baseUrl).toBe('http://192.168.0.7:1234/v1');
  });

  it('модуль пробы — точка егресса под надзором D2', () => {
    expect(LLM_EGRESS_FILES).toContain('lib/ai/local-model-probe.ts');
  });
});

describe('инструменты пробы — только читающие', () => {
  it('из настоящего списка публичного MCP не проходит ни одна запись', () => {
    const names = readOnlyToolsForProbe(PUBLIC_MCP_TOOLS as never).map((t) => t.function.name);
    expect(names).toContain('get_tours');
    expect(names).toContain('get_guardian_context');
    for (const w of [...WRITE_TOOL_NAMES, 'edit_trip_plan']) expect(names).not.toContain(w);
  });

  it('инструмент без пометки не предлагается: неизвестное не считается безопасным', () => {
    const out = readOnlyToolsForProbe([
      { name: 'a', annotations: { readOnlyHint: true } },
      { name: 'b' },
      { name: 'c', annotations: { readOnlyHint: false } },
    ]);
    expect(out.map((t) => t.function.name)).toEqual(['a']);
  });

  it('проба опознаётся журналом MCP как проверка, а не спрос', () => {
    expect(isProbeClient(LOCAL_PROBE_CLIENT, null)).toBe(true);
  });
});

describe('один вопрос: цикл инструментов', () => {
  it('модель просит инструмент, получает факт и отвечает', async () => {
    const { fetchImpl, bodies } = fakeServer([
      reply({ content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_tours', arguments: '{"query":"вулкан"}' } }] }, 'tool_calls'),
      reply({ content: 'Тур на Авачинский — от 12 000 ₽.' }, 'stop', { prompt_tokens: 400, completion_tokens: 30 }),
    ]);
    const callTool = vi.fn(async () => 'Авачинский: от 12 000 ₽');
    const r = await runProbeTurn({ cfg: CFG, system: LONG_SYSTEM, question: 'Сколько стоит?', tools: TOOLS, callTool, fetchImpl });
    expect(r.answer).toBe('Тур на Авачинский — от 12 000 ₽.');
    expect(r.toolCalls).toEqual(['get_tours']);
    expect(r.rounds).toBe(2);
    expect(r.error).toBeNull();
    expect(callTool).toHaveBeenCalledWith('get_tours', { query: 'вулкан' });
    const toolMsg = (bodies[1].messages as Array<{ role: string; tool_call_id?: string; content: string }>).find((m) => m.role === 'tool');
    expect(toolMsg).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'Авачинский: от 12 000 ₽' });
    expect(r.completionTokens).toBe(50);
    expect(r.promptTokens).toBe(400);
    expect(bodies[0].reasoning_effort).toBe('none');
    expect(bodies[0].tools).toEqual(TOOLS);
  });

  it('инструмент не из пробы и битые аргументы не доходят до MCP, модель узнаёт причину', async () => {
    const { fetchImpl, bodies } = fakeServer([
      reply({ content: '', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'create_lead', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'get_tours', arguments: '{не json' } },
      ] }, 'tool_calls'),
      reply({ content: 'Ответ без заявки.' }),
    ]);
    const callTool = vi.fn(async () => 'x');
    const r = await runProbeTurn({ cfg: CFG, system: LONG_SYSTEM, question: 'q', tools: TOOLS, callTool, fetchImpl });
    expect(callTool).not.toHaveBeenCalled();
    const tools = (bodies[1].messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool');
    expect(tools[0].content).toMatch(/create_lead в пробе нет/);
    expect(tools[1].content).toMatch(/не разобраны/);
    expect(r.answer).toBe('Ответ без заявки.');
  });

  it('модель без выключателя размышлений: повтор без параметра, и это названо', async () => {
    const { fetchImpl, bodies } = fakeServer([
      new Response('{"error":"model does not support thinking"}', { status: 400 }),
      reply({ content: 'Да.' }),
    ]);
    const r = await runProbeTurn({ cfg: CFG, system: LONG_SYSTEM, question: 'q', tools: [], callTool: async () => '', fetchImpl });
    expect(r.answer).toBe('Да.');
    expect(r.thinkParam).toBe('not-supported');
    expect(bodies[0].reasoning_effort).toBe('none');
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');
  });

  it('другой отказ 400 — отказ запроса, без повтора', async () => {
    const { fetchImpl } = fakeServer([new Response('model "m" not found', { status: 400 })]);
    const r = await runProbeTurn({ cfg: CFG, system: LONG_SYSTEM, question: 'q', tools: [], callTool: async () => '', fetchImpl });
    expect(r.answer).toBeNull();
    expect(r.error).toMatch(/HTTP 400: model "m" not found/);
  });

  it('пусто из-за упора в длину — отдельный провал, а не «ответил»', async () => {
    const { fetchImpl } = fakeServer([reply({ content: '<think>долго думал</think>' }, 'length')]);
    const r = await runProbeTurn({ cfg: CFG, system: LONG_SYSTEM, question: 'q', tools: [], callTool: async () => '', fetchImpl });
    expect(r.answer).toBeNull();
    expect(r.lengthCut).toBe(true);
    expect(r.reasoningChars).toBeGreaterThan(0);
    expect(summarizeProbe([r])).toMatchObject({ answered: 0, empty: 1, lengthCut: 1 });
  });

  it('размышление из поля reasoning и из блока <think> не попадает в ответ', async () => {
    const { fetchImpl } = fakeServer([reply({ content: '<think>план</think>Ответ.', reasoning: 'ещё мысли' })]);
    const r = await runProbeTurn({ cfg: CFG, system: LONG_SYSTEM, question: 'q', tools: [], callTool: async () => '', fetchImpl });
    expect(r.answer).toBe('Ответ.');
    expect(r.reasoningChars).toBe('<think>план</think>'.length + 'ещё мысли'.length);
  });

  it('сеть упала — отказ записан, исключение не летит наружу', async () => {
    const fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const r = await runProbeTurn({ cfg: CFG, system: LONG_SYSTEM, question: 'q', tools: [], callTool: async () => '', fetchImpl });
    expect(r.answer).toBeNull();
    expect(r.error).toBe('TypeError: fetch failed');
    expect(r.contextWarning).toBeNull();
  });

  it('бесконечные просьбы инструментов обрываются и называются', async () => {
    const ask = () => reply({ content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'get_tours', arguments: '{}' } }] }, 'tool_calls');
    const { fetchImpl } = fakeServer([ask, ask, ask]);
    const r = await runProbeTurn({ cfg: CFG, system: LONG_SYSTEM, question: 'q', tools: TOOLS, callTool: async () => 'ok', fetchImpl, maxRounds: 3 });
    expect(r.answer).toBeNull();
    expect(r.error).toMatch(/3 раундов подряд/);
  });

  it('ключ сервера модели уходит заголовком, когда задан', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>).authorization ?? '');
      return reply({ content: 'ok' });
    }) as unknown as typeof fetch;
    await runProbeTurn({ cfg: { ...CFG, apiKey: 'k' }, system: LONG_SYSTEM, question: 'q', tools: [], callTool: async () => '', fetchImpl });
    await runProbeTurn({ cfg: CFG, system: LONG_SYSTEM, question: 'q', tools: [], callTool: async () => '', fetchImpl });
    expect(seen).toEqual(['Bearer k', '']);
  });
});

describe('обрезанный контекст и сводка', () => {
  it('три признака обрезки и чистый случай', () => {
    expect(contextLooksTruncated(10_000, null)).toMatch(/usage/);
    expect(contextLooksTruncated(10_000, 4096)).toMatch(/OLLAMA_CONTEXT_LENGTH/);
    expect(contextLooksTruncated(30_000, 2000)).toMatch(/срезало/);
    expect(contextLooksTruncated(30_000, 9000)).toBeNull();
  });

  it('промпт Кузьмича в окно 4096 токенов — предупреждение в ответе пробы', async () => {
    const { fetchImpl } = fakeServer([reply({ content: 'ok' }, 'stop', { prompt_tokens: 4096, completion_tokens: 5 })]);
    const r = await runProbeTurn({ cfg: CFG, system: 'п'.repeat(30_000), question: 'q', tools: [], callTool: async () => '', fetchImpl });
    expect(r.contextWarning).toMatch(/4096/);
    expect(summarizeProbe([r]).contextWarnings).toBe(1);
  });

  it('скорость считается только по ответившим', () => {
    const base: TurnResult = {
      answer: 'a', ms: 1000, rounds: 1, toolCalls: [], finishReason: 'stop', promptTokens: 100,
      completionTokens: 10, reasoningChars: 0, thinkParam: 'sent-none', error: null, lengthCut: false, contextWarning: null,
    };
    const s = summarizeProbe([
      { ...base, ms: 1000 },
      { ...base, ms: 3000, toolCalls: ['get_tours'] },
      { ...base, ms: 9000 },
      { ...base, ms: 60_000, answer: null, error: 'TimeoutError: timeout' },
    ]);
    expect(s).toMatchObject({ total: 4, answered: 3, errors: 1, p50Ms: 3000, p95Ms: 9000, turnsWithTools: 1 });
    expect(s.tokensPerSec).toBe(Math.round((30 / 13) * 10) / 10);
    expect(summarizeProbe([])).toMatchObject({ p50Ms: null, p95Ms: null, tokensPerSec: null });
  });
});

describe('ответ MCP', () => {
  it('поток SSE: берётся последнее data', () => {
    expect(parseMcpBody('event: message\ndata: {"a":1}\n\ndata: {"b":2}\n')).toEqual({ b: 2 });
    expect(parseMcpBody('{"c":3}')).toEqual({ c: 3 });
  });
});
