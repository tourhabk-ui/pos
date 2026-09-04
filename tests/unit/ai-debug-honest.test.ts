/**
 * Диагностика провайдеров описывает ЖИВОЙ путь и называет форму отказа.
 *
 * ai-debug run 4 (04.09): 18 провайдеров, 0 работающих — и тут же E2E-проба
 * Кузьмича отвечает. Противоречие было в самой диагностике:
 *   - Gemini пробовался на снятом с эксплуатации id (404 при живом ключе);
 *   - MiMo, выключенный из водопада 04.07, красился красным как живой;
 *   - Qwen — живой путь судьи и tools-цикла — не пробовался вовсе;
 *   - DeepSeek ответил 200 с пустым content за 313 мс, и три пути записали
 *     одно слово «empty», не сохранив, ЧТО пришло в теле;
 *   - линза записала «decision_null» без причин по ступеням.
 *
 * §4.0: исход «не смог» обязан говорить, что именно получил.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeEmptyCompletion } from '@/lib/ai/failure-trace';

const ROOT = process.cwd();
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const PROVIDERS = strip(readFileSync(join(ROOT, 'lib/ai/providers.ts'), 'utf-8'));
const LENS = strip(readFileSync(join(ROOT, 'lib/agents/scout-ai-features.ts'), 'utf-8'));

const section = (from: string, to: string) => {
  const a = PROVIDERS.indexOf(from);
  const b = PROVIDERS.indexOf(to, a + 1);
  expect(a, `нет «${from}»`).toBeGreaterThan(-1);
  expect(b, `нет «${to}» после «${from}»`).toBeGreaterThan(a);
  return PROVIDERS.slice(a, b);
};

describe('форма пустого ответа', () => {
  it('error под HTTP 200, пустой choices, размышление без текста — три разных слова', () => {
    expect(describeEmptyCompletion({ error: { code: 'insufficient_quota' } })).toMatch(/error в теле под 200/);
    expect(describeEmptyCompletion({ id: 'x', choices: [] })).toMatch(/choices пуст; ключи тела: id,choices/);
    const r = describeEmptyCompletion({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '', reasoning_content: 'думаю'.repeat(10) } }] });
    expect(r).toMatch(/finish_reason=length/);
    expect(r).toMatch(/reasoning_content: 50 зн\./);
    expect(describeEmptyCompletion(null)).toMatch(/тело не объект/);
  });

  it('ключи в теле не показываются', () => {
    expect(describeEmptyCompletion({ error: { message: 'bad key sk-abcdefghijklmnop' } })).not.toMatch(/sk-abcdef/);
  });
});

describe('нативный Gemini — модель по /models, не хардкод', () => {
  it('в коде нет вызова generateContent на прибитом id', () => {
    expect(PROVIDERS).not.toMatch(/models\/gemini-2\.0-flash:generateContent/);
  });

  it('debug-проба и преполётная проба берут resolveGeminiModel и называют причину, когда списка нет', () => {
    const debug = section('export async function callAIWaterfallDebug', '\n  return results;');
    expect(debug).toMatch(/const gModel = apiKey \? await resolveGeminiModel\(\) : null/);
    expect(debug).toMatch(/geminiResolveProblem\(\)/);
    const preflight = section('async function probeGeminiDirect', 'const [providers, openrouter_balance]');
    expect(preflight).toMatch(/const model = await resolveGeminiModel\(\)/);
    expect(preflight).toMatch(/geminiResolveProblem\(\)/);
  });

  it('отказ списка моделей записывается словами, а не глотается', () => {
    const list = section('async function listGeminiModels', 'export async function resolveGeminiModel');
    expect(list).not.toMatch(/catch \{ return \[\]; \}/);
    expect(list).toMatch(/geminiListProblem = httpFailureReason/);
    expect(list).toMatch(/geminiListProblem = errorFailureReason\(e\)/);
  });
});

describe('debug-проба описывает живой водопад', () => {
  const debug = section('export async function callAIWaterfallDebug', '\n  return results;');

  it('MiMo (выключен 04.07) в пробе нет, Qwen (живой путь) — есть', () => {
    expect(debug).not.toMatch(/provider: 'mimo'/);
    expect(debug).toMatch(/provider: 'qwen'/);
    expect(debug).toMatch(/getQwenConfig\(\)/);
  });

  it('пустой content под 200 у DeepSeek и Qwen несёт форму тела', () => {
    expect(debug).toMatch(/provider: 'deepseek', model: label, status: 'empty_response', error: describeEmptyCompletion\(data\)/);
    // run 6: модель думает и не договаривает — рычаги меряются, а не угадываются.
    expect(debug).toMatch(/thinking: \{ type: 'disabled' \}/);
    expect(debug).toMatch(/\[thinking:on max_tokens:2000\]/);
    expect(debug).toMatch(/getProviderModelIds\('deepseek'\)/);
    expect(debug).toMatch(/provider: 'qwen', model, status: 'empty_response', error: describeEmptyCompletion\(data\)/);
  });
});

describe('преполётная проба DeepSeek: HTTP 200 без content — не зелёная', () => {
  it('тело читается и пустой content называется', () => {
    const probe = section('async function probeDeepSeek()', 'async function probeXai');
    expect(probe).toMatch(/HTTP 200, но content пуст: \$\{describeEmptyCompletion\(data\)\}/);
  });
});

describe('живые пути называют форму пустого ответа', () => {
  it('чат, судья и решатель — все три', () => {
    expect(PROVIDERS).toMatch(/recordAiLegFailure\('deepseek', `empty \(\$\{model\}\): \$\{describeEmptyCompletion\(data\)\}`\)/);
    expect(PROVIDERS).toMatch(/recordAiLegFailure\('deepseek:content', `empty \(\$\{model\}\): \$\{describeEmptyCompletion\(data\)\}`\)/);
    expect(PROVIDERS).toMatch(/recordAiLegFailure\('qwen:content', `empty \(\$\{model\}\): \$\{describeEmptyCompletion\(data\)\}`\)/);
    expect(PROVIDERS).toMatch(/why\.push\(`deepseek\(\$\{model\}\): пустой ответ — \$\{describeEmptyCompletion\(data\)\}`\)/);
  });
});

describe('линза: decision_null — с причинами по ступеням', () => {
  it('предложения просит у callAIDecisionDetailed и кладёт error в decision_detail', () => {
    expect(LENS).toMatch(/const decision = await callAIDecisionDetailed\(buildAiFeaturePrompt\(candidates, knownTopics\)\)/);
    expect(LENS).toMatch(/skip_reason: 'decision_null', decision_detail: decision\.error \?\? 'причина не записана'/);
    expect(LENS).toMatch(/decision_detail\?: string;/);
  });
});

/**
 * Рычаг, выбранный замером run 7 (04.09): DeepSeek V4 думает по умолчанию и
 * на бюджете ответа молчит; `thinking: disabled` отвечает за ~320 мс. Живой
 * путь — чат, tools-цикл, судья, решатель, пробы — просит ответ без
 * размышления одним и тем же способом.
 */
describe('DeepSeek: живой путь просит ответ без размышления', () => {
  it('deepseekThinking() спредится в каждое тело chat/completions к DeepSeek', () => {
    const bodies = PROVIDERS.split('api.deepseek.com/').slice(1)
      .filter((chunk) => chunk.startsWith('v1/chat/completions') || chunk.startsWith('chat/completions'))
      .map((chunk) => chunk.slice(0, 900));
    // ping-проба (max_tokens: 1) проверяет только HTTP и размышления не ждёт;
    // debug-проба (...v.extra) меряет рычаги намеренно, её базовая форма проверена выше.
    const answering = bodies.filter((b) => !/max_tokens: 1,/.test(b) && !/\.\.\.v\.extra/.test(b));
    expect(answering.length).toBeGreaterThanOrEqual(6);
    for (const b of answering) expect(b, b.slice(0, 200)).toMatch(/deepseekThinking\(\)|thinking: \{ type: 'disabled' \}/);
  });

  it('override DEEPSEEK_THINKING=1 возвращает размышление', async () => {
    const { deepseekThinking } = await import('@/lib/ai/providers');
    const prev = process.env.DEEPSEEK_THINKING;
    delete process.env.DEEPSEEK_THINKING;
    expect(deepseekThinking()).toEqual({ thinking: { type: 'disabled' } });
    process.env.DEEPSEEK_THINKING = '1';
    expect(deepseekThinking()).toEqual({});
    if (prev === undefined) delete process.env.DEEPSEEK_THINKING; else process.env.DEEPSEEK_THINKING = prev;
  });
});
