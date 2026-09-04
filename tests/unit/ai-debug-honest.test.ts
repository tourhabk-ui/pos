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
    expect(LENS).toMatch(/const decision = await callAIDecisionDetailed\(prompt\)/);
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

/**
 * xAI, 04.09. Владелец: «XAI_API_KEY геоблок», а провайдер отвечает
 * «Incorrect API key provided». Один из двух говорит не о том, и текстом
 * ответа это не решается: у отказа два кандидата, гео и ключ либо счёт.
 * Отсюда две правки: дорога меряется отдельной пробой БЕЗ ключа, а модель
 * берётся из каталога (в коде висел снятый с линейки grok-4, тогда как у
 * провайдера 4.6 / 4.5 / 4.3).
 */
describe('xAI: модель из каталога, дорога меряется без ключа', () => {
  it('хардкода grok-4 не осталось нигде', () => {
    expect(PROVIDERS).not.toMatch(/'grok-4'/);
    expect(PROVIDERS).toMatch(/export async function resolveXaiModel/);
    expect(PROVIDERS).toMatch(/fetchModelIds\('https:\/\/api\.x\.ai\/v1\/models'/);
  });

  /**
   * run 8 (04.09) закрыл спор замером: проба без ключа получила от api.x.ai
   * его СОБСТВЕННЫЙ ответ (401 «No credentials presented»), а по ключу
   * прочитался каталог — недействительный ключ каталог не отдаёт. Значит
   * дорога открыта, ключ жив, а «Incorrect API key provided» xAI отвечает на
   * неизвестную модель: мы звали снятый с линейки grok-4.
   */
  it('поправка к отказу xAI несёт ЗАМЕР, а не пересказ догадки', async () => {
    const { refusalNote } = await import('@/lib/ai/refusal-notes');
    const note = refusalNote('xai', 400, '{"error":"Incorrect API key provided."}') ?? '';
    expect(note).toMatch(/ЗАМЕРЕНО 04\.09/);
    expect(note).toMatch(/Ключ не перевыпускать/);
    expect(note).toMatch(/неизвестн/i);
    // Догадка про гео из поправки убрана: замер её опроверг.
    expect(note).not.toMatch(/ДВА кандидата/);
  });

  it('флагману дан бюджет, а рядом меряется лёгкая модель каталога', () => {
    const debug = section('export async function callAIWaterfallDebug', '\n  return results;');
    expect(debug).toMatch(/provider: 'xai:light'/);
    // 15 с не хватило флагману с размышлением (run 8) — таймаут вместо ответа.
    expect(debug).toMatch(/AbortSignal\.timeout\(60_000\)/);
  });

  it('живой путь и пробы спрашивают каталог и называют его отказ словами', () => {
    expect(PROVIDERS).toMatch(/recordAiLegFailure\('xai', `модель не разрешена: \$\{xaiResolveProblem\(\)/);
    const debug = section('export async function callAIWaterfallDebug', '\n  return results;');
    expect(debug).toMatch(/provider: 'xai:reachability'/);
    expect(debug).toMatch(/const xModel = apiKey \? await resolveXaiModel\(\) : null/);
  });

  it('проба дороги идёт без Authorization: она о дороге, а не о ключе', () => {
    const probe = PROVIDERS.slice(
      PROVIDERS.indexOf('export async function probeXaiReachable'),
      PROVIDERS.indexOf('export async function callXai'),
    );
    expect(probe).not.toMatch(/Authorization/);
    expect(probe).toMatch(/reached: true/);
    expect(probe).toMatch(/reached: null/);
  });
});

/**
 * Отказ, который лжёт о причине, обязан идти с поправкой — но поправка не
 * заменяет ответ провайдера и не выдаёт свидетельство за замер.
 */
describe('поправки к лживым отказам', () => {
  it('xAI, Gemini и край Cloudflare опознаются по своим признакам', async () => {
    const { refusalNote } = await import('@/lib/ai/refusal-notes');
    expect(refusalNote('xai', 400, '{"code":"invalid-argument","error":"Incorrect API key provided."}'))
      .toMatch(/ЗАМЕРЕНО/);
    expect(refusalNote('gemini', 400, 'User location is not supported for the API use.'))
      .toMatch(/Гео-отказ Google/);
    expect(refusalNote('openrouter', 403, '{ "success": false, "error": "Access denied by security policy." }'))
      .toMatch(/ответ КРАЯ Cloudflare/);
  });

  it('о чём не известно — молчит, а не выдумывает', () => {
    expect(PROVIDERS).toMatch(/const note = refusalNote\(r\.provider, r\.http_status \?\? null, r\.error\)/);
  });

  it('поправка не подменяет ответ провайдера', async () => {
    const { refusalNote } = await import('@/lib/ai/refusal-notes');
    expect(refusalNote('deepseek', 402, 'Insufficient balance')).toBeNull();
    expect(refusalNote('xai', 200, 'ok')).toBeNull();
    expect(refusalNote('mistral', 429, 'Rate limit exceeded')).toBeNull();
  });
});

/**
 * xAI подключён к живым путям — по замеру, а не по вере.
 *
 * ai-debug run 10 (04.09, с прода): grok-4.6 ответил за 43 127 мс,
 * grok-build-0.1 — за 13 169 мс. До этого дня callXai не звался НИ ОДНИМ
 * живым путём (только админской проверкой), модель была прибита к снятому
 * grok-4, бюджет стоял 20 с, а отказ уходил молчаливым null: тело ошибки
 * читалось в переменную и выбрасывалось. Работающий провайдер числился
 * мёртвым, и ни одна строка кода об этом не говорила.
 */
describe('xAI: живой провайдер, а не украшение', () => {
  it('назначения разведены: живому пути — быстрая модель, генерации — флагман', () => {
    expect(PROVIDERS).toMatch(/resolveXaiModel\(purpose: 'strong' \| 'fast' = 'strong'\)/);
    expect(PROVIDERS).toMatch(/mini\|fast\|flash\|lite\|build/);
    // Живой путь Кузьмича: 43 с флагмана — это «не ответил», а не «медленно».
    expect(PROVIDERS).toMatch(/callXai\(messages, \{ purpose: 'fast' \}\)/);
    expect(PROVIDERS).toMatch(/callXai\(messages, \{ purpose: 'strong', timeoutMs: 90_000, maxTokens \}\)/);
  });

  it('водопад его наконец зовёт', () => {
    // Срезы берём по КОДУ: PROVIDERS очищен от комментариев, и якорь-комментарий
    // молча даёт indexOf -1, то есть тест проверяет не тот кусок (или весь файл).
    const tier2 = PROVIDERS.slice(PROVIDERS.indexOf('callYandexGPT(messages)'), PROVIDERS.indexOf('const anthropic = await callAnthropic'));
    expect(tier2, 'xAI снова не подключён ни к одному живому пути').toMatch(/callXai\(/);
  });

  it('отказ xAI называется, а не глотается', () => {
    const leg = PROVIDERS.slice(PROVIDERS.indexOf('export async function callXai'), PROVIDERS.indexOf('export const CACHE_BREAK_MARKER'));
    expect(leg).toMatch(/recordAiLegFailure\('xai', httpFailureReason/);
    expect(leg).toMatch(/recordAiLegFailure\('xai', `empty/);
    expect(leg).toMatch(/recordAiLegFailure\('xai', errorFailureReason\(e\)\)/);
    // Прежний немой отказ: тело читалось в переменную и выбрасывалось.
    expect(leg).not.toMatch(/const errText = await res\.text\(\)\.catch\(\(\) => ''\);\s*\n\s*return null;/);
  });

  it('бюджет времени взят из замера, а не из привычки', () => {
    const leg = PROVIDERS.slice(PROVIDERS.indexOf('export async function callXai'), PROVIDERS.indexOf('export const CACHE_BREAK_MARKER'));
    expect(leg).toMatch(/timeoutMs = purpose === 'fast' \? 30_000 : 90_000/);
    // 20 с обрезали обе модели на флагмане.
    expect(leg).not.toMatch(/AbortSignal\.timeout\(20_000\)/);
  });
});
