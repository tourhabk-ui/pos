/**
 * Панель видимости — вопросы ассистентам (замер владельца 16.10).
 *
 * Критерии записаны до первого прогона: docs/agents/AI_VISIBILITY.md. Здесь —
 * как спрашивается один день панели: какие ассистенты, какая модель у каждого,
 * сколько это стоит до первого вызова и как ответ превращается в сырьё. Счёт
 * по сырью — lib/ai/visibility-panel.ts.
 *
 * Спрашивается С РАННЕРА GitHub через OpenRouter: OpenAI и xAI с прода закрыты
 * гео-блоком, Gemini и Perplexity — те же поверхности (§8, «Два ключа»).
 * Поиск — движком самого вендора (плагин web, engine native) или встроенный
 * (Perplexity Sonar ищет сам). Отказ в движке вендора — «не измерено», а не
 * повтор через чужой поиск: Exa вместо Google — это другой ассистент.
 *
 * YandexGPT здесь не спрашивается, и это названо, а не пропущено: на раннере
 * нет ключа Яндекса, а у нашей ноги YandexGPT нет поиска — ответ с поиском
 * не измерить. Алиса меряется только выгрузкой «Видимость в Алисе AI».
 */
import { openRouterAttribution } from '@/lib/ai/attribution';
import { pickWestModel } from '@/lib/ai/west-probe';
import { markAnswer, type AnswerMarks, type PanelQuestion } from '@/lib/ai/visibility-panel';
import type { UsageRowToReport } from '@/lib/ai/usage-sink';

const OPENROUTER = 'https://openrouter.ai/api/v1';
export const PANEL_AGENT_ID = 'ai-visibility-panel';
export const PANEL_CALL_TIMEOUT_MS = 120_000;
const CATALOG_TIMEOUT_MS = 30_000;
/**
 * Потолок ответа. Не параметр вкуса, а предохранитель цены: у рассуждающих
 * моделей в него входит и рассуждение. Одинаков в базе и в повторе.
 */
export const PANEL_MAX_TOKENS = 3000;
/**
 * Оценка вызова до первого запроса: вход поискового ответа — ~24,5 тыс.
 * токенов (проба GPT/Grok, прогон 1, 16.10), выход — около тысячи. Это
 * только оценка для потолка: настоящая цена каждого ответа берётся из
 * usage.cost OpenRouter.
 */
export const EST_PROMPT_TOKENS = 25_000;
export const EST_COMPLETION_TOKENS = 1_200;
const EXCERPT = 300;

export type AssistantId = 'chatgpt' | 'perplexity' | 'gemini' | 'grok' | 'yandexgpt';
export const PANEL_ASSISTANTS: readonly AssistantId[] = ['chatgpt', 'perplexity', 'gemini', 'grok', 'yandexgpt'];

export type SearchMode = 'vendor_plugin' | 'built_in';

export interface AssistantSpec {
  id: AssistantId;
  label: string;
  /** Модель из каталога OpenRouter; null — подходящей нет. */
  pick: (ids: readonly string[]) => string | null;
  search: SearchMode;
  /** Почему с раннера не измерить вовсе; null — измеряется. */
  unavailable: string | null;
}

/** Основная Flash Gemini: `google/gemini-<версия>-flash` без lite, image, preview и режимов. */
export function pickGeminiFlash(ids: readonly string[]): string | null {
  const cand = ids
    .map((id) => ({ id, m: id.match(/^google\/gemini-(\d+(?:\.\d+)?)-flash$/) }))
    .filter((x): x is { id: string; m: RegExpMatchArray } => x.m !== null);
  if (!cand.length) return null;
  return cand.sort((a, b) => Number(b.m[1]) - Number(a.m[1]))[0].id;
}

export const ASSISTANT_SPECS: Record<AssistantId, AssistantSpec> = {
  chatgpt: { id: 'chatgpt', label: 'ChatGPT (OpenAI, поиск OpenAI)', pick: (ids) => pickWestModel(ids, 'openai'), search: 'vendor_plugin', unavailable: null },
  perplexity: { id: 'perplexity', label: 'Perplexity Sonar (поиск встроен)', pick: (ids) => (ids.includes('perplexity/sonar') ? 'perplexity/sonar' : null), search: 'built_in', unavailable: null },
  gemini: { id: 'gemini', label: 'Gemini Flash (поиск Google)', pick: pickGeminiFlash, search: 'vendor_plugin', unavailable: null },
  grok: { id: 'grok', label: 'Grok (xAI, поиск xAI)', pick: (ids) => pickWestModel(ids, 'xai'), search: 'vendor_plugin', unavailable: null },
  yandexgpt: {
    id: 'yandexgpt',
    label: 'YandexGPT',
    pick: () => null,
    search: 'built_in',
    unavailable: 'на раннере нет ключа Яндекса, а у нашей ноги YandexGPT нет поиска — ответ с поиском не измерить; Алиса — только выгрузкой «Видимость в Алисе AI»',
  },
};

// ── Каталог с ценами ────────────────────────────────────────────────────

export interface PricedModel {
  id: string;
  /** Доллары за токен входа / выхода и за один поиск; null — каталог не назвал. */
  prompt: number | null;
  completion: number | null;
  web_search: number | null;
}

export type PricedCatalog = { ok: true; models: PricedModel[] } | { ok: false; reason: string };

const price = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export async function readPricedCatalog(fetchImpl: typeof fetch, apiKey?: string): Promise<PricedCatalog> {
  try {
    const res = await fetchImpl(`${OPENROUTER}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    const body = await res.text();
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status} ${body.slice(0, EXCERPT)}`.trim() };
    const list = (JSON.parse(body) as { data?: unknown })?.data;
    const models = (Array.isArray(list) ? list : []).flatMap((m): PricedModel[] => {
      const r = (m ?? {}) as { id?: unknown; pricing?: Record<string, unknown> };
      if (typeof r.id !== 'string' || !r.id) return [];
      return [{ id: r.id, prompt: price(r.pricing?.prompt), completion: price(r.pricing?.completion), web_search: price(r.pricing?.web_search) }];
    });
    if (!models.length) return { ok: false, reason: 'каталог пуст или без поля data[].id' };
    return { ok: true, models };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

// ── Модели дня ──────────────────────────────────────────────────────────

export interface PanelModel {
  assistant: AssistantId;
  label: string;
  search: SearchMode;
  model: string | null;
  source: 'catalog' | 'marker' | null;
  /** Почему ассистент не спрашивается; null — спрашивается. */
  reason: string | null;
  price: Omit<PricedModel, 'id'> | null;
}

export function choosePanelModels(
  catalog: PricedCatalog,
  assistants: readonly AssistantId[],
  overrides: Partial<Record<AssistantId, string>> = {},
): PanelModel[] {
  return assistants.map((a) => {
    const spec = ASSISTANT_SPECS[a];
    const base = { assistant: a, label: spec.label, search: spec.search };
    if (spec.unavailable) return { ...base, model: null, source: null, reason: spec.unavailable, price: null };
    if (!catalog.ok) return { ...base, model: null, source: null, reason: `каталог OpenRouter не прочитан: ${catalog.reason}`, price: null };
    const forced = overrides[a]?.trim();
    const model = forced || spec.pick(catalog.models.map((m) => m.id));
    if (!model) return { ...base, model: null, source: null, reason: 'в каталоге OpenRouter подходящей модели нет', price: null };
    const p = catalog.models.find((m) => m.id === model);
    return {
      ...base, model, source: forced ? 'marker' : 'catalog', reason: null,
      price: p ? { prompt: p.prompt, completion: p.completion, web_search: p.web_search } : null,
    };
  });
}

/** Оценка одного вызова, долларов; null — цена в каталоге не названа целиком. */
export function estimateCallUsd(m: Pick<PanelModel, 'price'>): number | null {
  const p = m.price;
  if (!p || p.prompt === null || p.completion === null || p.web_search === null) return null;
  return EST_PROMPT_TOKENS * p.prompt + EST_COMPLETION_TOKENS * p.completion + p.web_search;
}

export interface PanelPlan {
  calls: number;
  per_assistant: Array<{ assistant: AssistantId; model: string | null; calls: number; est_usd: number | null; reason: string | null }>;
  /** Оценка дня; null — хотя бы у одного спрашиваемого ассистента цены нет, и потолок не проверить. */
  est_usd: number | null;
}

export function planDay(questions: readonly PanelQuestion[], models: readonly PanelModel[], repeats: number): PanelPlan {
  const per_assistant = models.map((m) => {
    const calls = m.model ? questions.length * repeats : 0;
    const one = m.model ? estimateCallUsd(m) : 0;
    return { assistant: m.assistant, model: m.model, calls, est_usd: one === null ? null : one * calls, reason: m.reason };
  });
  const asked = per_assistant.filter((p) => p.calls > 0);
  return {
    calls: asked.reduce((s, p) => s + p.calls, 0),
    per_assistant,
    est_usd: asked.some((p) => p.est_usd === null) ? null : asked.reduce((s, p) => s + (p.est_usd ?? 0), 0),
  };
}

// ── Один вопрос ─────────────────────────────────────────────────────────

export interface AskDeps {
  fetchImpl: typeof fetch;
  apiKey: string | undefined;
  timeoutMs?: number;
}

export interface AskResult {
  outcome: 'answered' | 'could_not_ask' | 'not_measured';
  reason: string | null;
  text: string;
  sources: string[];
  answered_model: string | null;
  finish_reason: string | null;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
  /** Цена ответа по OpenRouter (usage.cost), с поиском; null — не назвал. */
  cost_usd: number | null;
  latency_ms: number;
}

const oneLine = (s: string, max = EXCERPT) => s.replace(/\s+/g, ' ').trim().slice(0, max);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Отказ OpenRouter в плагине или движке поиска. */
const ENGINE_REFUSAL = /engine|plugin|web.?search/i;

/** Источники ответа: аннотации url_citation и верхний список citations (так отдаёт Perplexity). */
export function extractSources(data: unknown): string[] {
  const d = (data ?? {}) as { citations?: unknown; choices?: Array<{ message?: { annotations?: unknown } }> };
  const out: string[] = [];
  const ann = d.choices?.[0]?.message?.annotations;
  for (const a of Array.isArray(ann) ? ann : []) {
    const x = a as { type?: unknown; url?: unknown; url_citation?: { url?: unknown } };
    if (x?.type !== 'url_citation') continue;
    const url = typeof x.url_citation?.url === 'string' ? x.url_citation.url : typeof x.url === 'string' ? x.url : '';
    out.push(url);
  }
  for (const c of Array.isArray(d.citations) ? d.citations : []) {
    if (typeof c === 'string' && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * Один вопрос одному ассистенту. Никогда не бросает: отказ — could_not_ask
 * с причиной, отказ в поиске вендора — not_measured (§4.0).
 */
export async function askAssistant(m: PanelModel, question: Pick<PanelQuestion, 'text'>, deps: AskDeps): Promise<AskResult> {
  const started = Date.now();
  const empty = { text: '', sources: [] as string[], answered_model: null, finish_reason: null, usage: null, cost_usd: null };
  const fail = (outcome: 'could_not_ask' | 'not_measured', reason: string, extra: Partial<AskResult> = {}): AskResult =>
    ({ ...empty, outcome, reason, latency_ms: Date.now() - started, ...extra });

  if (!m.model) return fail('not_measured', m.reason ?? 'модель не выбрана');
  if (!deps.apiKey) return fail('could_not_ask', 'OPENROUTER_API_KEY не задан — спросить нечем');

  const body = {
    model: m.model,
    messages: [{ role: 'user', content: question.text }],
    max_tokens: PANEL_MAX_TOKENS,
    usage: { include: true },
    ...(m.search === 'vendor_plugin' ? { plugins: [{ id: 'web', engine: 'native' }] } : {}),
  };
  const ms = deps.timeoutMs ?? PANEL_CALL_TIMEOUT_MS;
  let status = 0;
  let raw = '';
  try {
    const res = await deps.fetchImpl(`${OPENROUTER}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${deps.apiKey}`, ...openRouterAttribution('ai visibility panel') },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    status = res.status;
    raw = await res.text();
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail('could_not_ask', timeout ? `таймаут ${Math.round(ms / 1000)} с` : `сеть: ${oneLine(err instanceof Error ? err.message : String(err))}`);
  }
  if (status < 200 || status >= 300) {
    if (status === 400 && m.search === 'vendor_plugin' && ENGINE_REFUSAL.test(raw)) {
      return fail('not_measured', `поиск вендора через OpenRouter не принят: HTTP 400 ${oneLine(raw, 200)}`);
    }
    return fail('could_not_ask', `HTTP ${status}: ${oneLine(raw) || 'тело пустое'}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return fail('could_not_ask', `ответ 200 не разобран как JSON: ${oneLine(err instanceof Error ? err.message : String(err))}`);
  }
  const d = data as {
    model?: unknown;
    error?: { message?: unknown; code?: unknown };
    choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
  };
  const choice = Array.isArray(d.choices) ? d.choices[0] : undefined;
  const prompt = num(d.usage?.prompt_tokens);
  const completion = num(d.usage?.completion_tokens);
  const traced: Partial<AskResult> = {
    answered_model: typeof d.model === 'string' && d.model.trim() ? d.model.trim() : null,
    finish_reason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    usage: prompt !== null && completion !== null ? { prompt_tokens: prompt, completion_tokens: completion } : null,
    cost_usd: num(d.usage?.cost),
  };
  if (!choice) {
    const msg = typeof d.error?.message === 'string' ? d.error.message : 'нет ни ответа, ни ошибки';
    return fail('could_not_ask', `ошибка в теле ответа 200: ${oneLine(msg)}`, traced);
  }
  const text = typeof choice.message?.content === 'string' ? choice.message.content : '';
  if (!text.trim()) return fail('could_not_ask', `ответ пустой: finish_reason ${traced.finish_reason ?? 'не назван'}`, traced);
  return { ...empty, ...traced, outcome: 'answered', reason: null, text, sources: extractSources(data), latency_ms: Date.now() - started };
}

// ── День панели ─────────────────────────────────────────────────────────

/** Строка сырья: один ответ одного ассистента на один вопрос. */
export interface PanelRecord {
  assistant: AssistantId;
  model: string | null;
  question_id: string;
  lang: PanelQuestion['lang'];
  intent: PanelQuestion['intent'];
  day: string;
  repeat: number;
  asked_at: string;
  outcome: AskResult['outcome'];
  reason: string | null;
  text: string;
  sources: string[];
  marks: AnswerMarks | null;
  answered_model: string | null;
  finish_reason: string | null;
  usage: AskResult['usage'];
  cost_usd: number | null;
  latency_ms: number;
}

export interface DayDeps extends AskDeps {
  /** Потолок дня, долларов: дальше вызовы не идут, остаток — could_not_ask с причиной. */
  maxUsd: number;
  concurrency?: number;
  now?: () => Date;
}

export interface DayResult {
  records: PanelRecord[];
  spent_usd: number;
  /** Сколько вызовов не пошло из-за потолка. */
  stopped_by_budget: number;
  usage_rows: UsageRowToReport[];
}

/**
 * Один день: каждый вопрос каждому спрашиваемому ассистенту `repeats` раз.
 * Порядок — повтор, вопрос, ассистент: если упрёмся в потолок, недобор
 * ляжет на все ассистенты поровну, а не на последнего в списке.
 */
export async function runPanelDay(
  questions: readonly PanelQuestion[],
  models: readonly PanelModel[],
  opts: { day: string; repeats: number },
  deps: DayDeps,
): Promise<DayResult> {
  const asked = models.filter((m) => m.model);
  const jobs: Array<{ q: PanelQuestion; m: PanelModel; repeat: number }> = [];
  for (let r = 1; r <= opts.repeats; r++) for (const q of questions) for (const m of asked) jobs.push({ q, m, repeat: r });

  const records: PanelRecord[] = new Array(jobs.length);
  let spent = 0;
  let inflight = 0;
  let stopped = 0;
  let next = 0;
  const now = () => (deps.now ? deps.now() : new Date()).toISOString();

  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      const { q, m, repeat } = jobs[i];
      const base = {
        assistant: m.assistant, model: m.model, question_id: q.id, lang: q.lang, intent: q.intent,
        day: opts.day, repeat, asked_at: now(),
      };
      const est = estimateCallUsd(m) ?? 0;
      if (spent + inflight + est > deps.maxUsd) {
        stopped++;
        records[i] = {
          ...base, outcome: 'could_not_ask', reason: `потолок дня ${deps.maxUsd} $ — вызов не пошёл`, text: '', sources: [],
          marks: null, answered_model: null, finish_reason: null, usage: null, cost_usd: null, latency_ms: 0,
        };
        continue;
      }
      inflight += est;
      const r = await askAssistant(m, q, deps);
      inflight -= est;
      // Цена ответа — от OpenRouter; не назвал — считаем по оценке, чтобы потолок не протёк.
      spent += r.cost_usd ?? (r.outcome === 'answered' ? est : 0);
      records[i] = { ...base, ...r, marks: r.outcome === 'answered' ? markAnswer(r.text, r.sources) : null };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.concurrency ?? 6, jobs.length || 1)) }, worker));

  const usage_rows: UsageRowToReport[] = records.flatMap((r) => (r.usage
    ? [{ model: r.answered_model ?? r.model ?? 'unknown', prompt_tokens: r.usage.prompt_tokens, completion_tokens: r.usage.completion_tokens, agent_id: PANEL_AGENT_ID }]
    : []));
  return { records, spent_usd: spent, stopped_by_budget: stopped, usage_rows };
}
