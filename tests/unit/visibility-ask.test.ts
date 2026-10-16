/**
 * Панель видимости — вопросы ассистентам (замер владельца 16.10; критерии —
 * docs/agents/AI_VISIBILITY.md). Сторож зовёт функции на подложенном fetch:
 * какая модель у ассистента, что уходит в запрос (вопрос — единственное
 * сообщение, поиск — движком вендора), что значит отказ в поиске вендора и
 * как держится потолок дня (CLAUDE.md §4: правило в функции — вызовом).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  askAssistant, choosePanelModels, estimateCallUsd, extractSources, pickGeminiFlash, planDay, runPanelDay,
  PANEL_ASSISTANTS, PANEL_AGENT_ID,
  type PanelModel, type PricedCatalog,
} from '@/lib/ai/visibility-ask';
import { parseQuestions } from '@/lib/ai/visibility-panel';

const CATALOG_IDS = [
  'google/gemini-3.8-flash', 'google/gemini-3.8-flash:batch', 'google/gemini-3.5-flash-lite', 'google/gemini-3.7-flash',
  'google/gemini-3.1-flash-image', 'google/gemini-3-flash-preview', 'google/gemini-4-argon',
  'openai/gpt-6.1-sol', 'openai/gpt-6.1-sol-pro', 'openai/gpt-6-luna',
  'x-ai/grok-4.5', 'x-ai/grok-4.20', 'perplexity/sonar', 'perplexity/sonar-pro',
];
const catalog: PricedCatalog = {
  ok: true,
  models: CATALOG_IDS.map((id) => ({ id, prompt: 0.000002, completion: 0.00001, web_search: 0.01 })),
};

const model = (over: Partial<PanelModel> = {}): PanelModel => ({
  assistant: 'chatgpt', label: 'ChatGPT', search: 'vendor_plugin', model: 'openai/gpt-6.1-sol', source: 'catalog', reason: null,
  price: { prompt: 0.000002, completion: 0.00001, web_search: 0.01 }, ...over,
});

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const answer = (content: string, extra: Record<string, unknown> = {}) => ({
  model: 'openai/gpt-6.1-sol-2026',
  choices: [{ message: { content, annotations: [{ type: 'url_citation', url_citation: { url: 'https://kamchatkaland.ru/t' } }] }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 24000, completion_tokens: 700, cost: 0.062 },
  ...extra,
});

const questions = parseQuestions([
  { id: 'q1', text: 'Сколько стоит тур на вулкан?', lang: 'ru', intent: 'prices', source: 'wordstat' },
  { id: 'q2', text: 'Kamchatka tours in August', lang: 'en', intent: 'tours_dates', source: 'gsc' },
]).questions;

describe('модель у каждого ассистента', () => {
  it('Gemini — основная Flash последней версии, без lite, image, preview и режимов', () => {
    expect(pickGeminiFlash(CATALOG_IDS)).toBe('google/gemini-3.8-flash');
    expect(pickGeminiFlash(['google/gemini-3.5-flash-lite'])).toBeNull();
  });

  it('из каталога: общая модель OpenAI и xAI, Sonar у Perplexity; YandexGPT назван неизмеримым с причиной', () => {
    const ms = choosePanelModels(catalog, PANEL_ASSISTANTS);
    const by = Object.fromEntries(ms.map((m) => [m.assistant, m]));
    expect(by.chatgpt.model).toBe('openai/gpt-6.1-sol');
    expect(by.grok.model).toBe('x-ai/grok-4.5');
    expect(by.perplexity.model).toBe('perplexity/sonar');
    expect(by.perplexity.search).toBe('built_in');
    expect(by.gemini.search).toBe('vendor_plugin');
    expect(by.yandexgpt.model).toBeNull();
    expect(by.yandexgpt.reason).toMatch(/нет ключа Яндекса.*нет поиска/);
  });

  it('маркер сильнее каталога; каталог не прочитан — у всех причина, модели нет', () => {
    expect(choosePanelModels(catalog, ['chatgpt'], { chatgpt: 'openai/gpt-6-luna' })[0]).toMatchObject({ model: 'openai/gpt-6-luna', source: 'marker' });
    const bad = choosePanelModels({ ok: false, reason: 'HTTP 503' }, ['chatgpt', 'grok']);
    expect(bad.every((m) => m.model === null && /HTTP 503/.test(m.reason ?? ''))).toBe(true);
  });
});

describe('план и цена дня — до первого вызова', () => {
  it('вызовов: вопросы × повторы на каждого измеряемого; неизмеримый — ноль', () => {
    const ms = choosePanelModels(catalog, ['chatgpt', 'perplexity', 'yandexgpt']);
    const plan = planDay(questions, ms, 5);
    expect(plan.calls).toBe(2 * 5 * 2);
    expect(plan.per_assistant.find((p) => p.assistant === 'yandexgpt')).toMatchObject({ calls: 0 });
    expect(plan.est_usd).toBeCloseTo(20 * estimateCallUsd(ms[0])!);
  });

  it('цена не названа каталогом — оценки дня нет, а не ноль', () => {
    const ms = [model({ price: { prompt: 0.000002, completion: 0.00001, web_search: null } })];
    expect(planDay(questions, ms, 1).est_usd).toBeNull();
  });
});

describe('один вопрос', () => {
  it('запрос: вопрос — единственное сообщение, без системного промпта и температуры; поиск — движком вендора', async () => {
    const fetchImpl = vi.fn(async () => ok(answer('Туры есть на vedarai.ru')));
    const r = await askAssistant(model(), { text: 'Сколько стоит тур на вулкан?' }, { fetchImpl, apiKey: 'k' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(String(init.body));
    expect(body.messages).toEqual([{ role: 'user', content: 'Сколько стоит тур на вулкан?' }]);
    expect(body).not.toHaveProperty('temperature');
    expect(body.plugins).toEqual([{ id: 'web', engine: 'native' }]);
    expect(body.usage).toEqual({ include: true });
    expect(r).toMatchObject({ outcome: 'answered', cost_usd: 0.062, answered_model: 'openai/gpt-6.1-sol-2026', sources: ['https://kamchatkaland.ru/t'] });
  });

  it('у Perplexity поиск встроен — плагина нет; верхний список citations тоже источник', async () => {
    const fetchImpl = vi.fn(async () => ok(answer('ответ', { citations: ['https://visitkamchatka.ru/a', 'https://kamchatkaland.ru/t'] })));
    const r = await askAssistant(model({ assistant: 'perplexity', search: 'built_in', model: 'perplexity/sonar' }), { text: 'q' }, { fetchImpl, apiKey: 'k' });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).not.toHaveProperty('plugins');
    expect(r.sources).toEqual(['https://kamchatkaland.ru/t', 'https://visitkamchatka.ru/a']);
  });

  it('отказ в поиске вендора — «не измерено», без повтора через чужой поиск', async () => {
    const fetchImpl = vi.fn(async () => ok({ error: { message: 'web search engine "native" is not supported for this model' } }, 400));
    const r = await askAssistant(model({ assistant: 'gemini', model: 'google/gemini-3.8-flash' }), { text: 'q' }, { fetchImpl, apiKey: 'k' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe('not_measured');
    expect(r.reason).toMatch(/поиск вендора/);
  });

  it('прочие отказы — «не смог» с причиной; пустой ответ — тоже', async () => {
    const r500 = await askAssistant(model(), { text: 'q' }, { fetchImpl: async () => ok({ error: 'upstream' }, 502), apiKey: 'k' });
    expect(r500).toMatchObject({ outcome: 'could_not_ask' });
    expect(r500.reason).toMatch(/HTTP 502/);
    const blank = await askAssistant(model(), { text: 'q' }, { fetchImpl: async () => ok(answer('  ')), apiKey: 'k' });
    expect(blank.outcome).toBe('could_not_ask');
    expect(blank.reason).toMatch(/пустой/);
  });

  it('без ключа — ни одного запроса', async () => {
    const fetchImpl = vi.fn();
    const r = await askAssistant(model(), { text: 'q' }, { fetchImpl, apiKey: undefined });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.outcome).toBe('could_not_ask');
  });

  it('источники без адреса считаются, а не теряются', () => {
    expect(extractSources({ choices: [{ message: { annotations: [{ type: 'url_citation', url_citation: {} }, { type: 'file' }] } }] })).toEqual(['']);
  });
});

describe('день панели', () => {
  it('каждый вопрос каждому ассистенту repeats раз; разметка и строки расхода', async () => {
    const fetchImpl = vi.fn(async () => ok(answer('см. vedarai.ru')));
    const ms = [model(), model({ assistant: 'grok', model: 'x-ai/grok-4.5' }), model({ assistant: 'yandexgpt', model: null, reason: 'нет ключа' })];
    const r = await runPanelDay(questions, ms, { day: 'base-1', repeats: 3 }, { fetchImpl, apiKey: 'k', maxUsd: 100, concurrency: 3 });
    expect(r.records).toHaveLength(2 * 3 * 2);
    expect(fetchImpl).toHaveBeenCalledTimes(12);
    expect(r.records.every((x) => x.marks?.ours === true && x.day === 'base-1')).toBe(true);
    expect(r.spent_usd).toBeCloseTo(12 * 0.062);
    expect(r.usage_rows).toHaveLength(12);
    expect(r.usage_rows[0].agent_id).toBe(PANEL_AGENT_ID);
  });

  it('потолок дня: вызовы сверх него не идут и названы, недобор — на всех ассистентах', async () => {
    const fetchImpl = vi.fn(async () => ok(answer('нет')));
    const ms = [model(), model({ assistant: 'grok', model: 'x-ai/grok-4.5' })];
    const one = estimateCallUsd(ms[0])!;
    const r = await runPanelDay(questions, ms, { day: 'd', repeats: 5 }, { fetchImpl, apiKey: 'k', maxUsd: one * 4.5, concurrency: 1 });
    const asked = r.records.filter((x) => x.outcome === 'answered');
    expect(asked.length).toBeLessThan(r.records.length);
    expect(r.stopped_by_budget).toBe(r.records.length - asked.length);
    expect(r.records.filter((x) => x.outcome === 'could_not_ask').every((x) => /потолок/.test(x.reason ?? ''))).toBe(true);
    expect(new Set(asked.map((x) => x.assistant))).toEqual(new Set(['chatgpt', 'grok']));
  });

});
