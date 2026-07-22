/**
 * Shared AI provider functions — waterfall pattern.
 * MiMo-V2-Pro (Xiaomi) → OpenRouter (GPT-4o-mini) → xAI (Grok) → Anthropic (Haiku)
 *
 * Env vars:
 *   XIAOMI_API_KEY          — Xiaomi MiMo ($1/1M tokens, 1M context)
 *   OPENROUTER_API_KEY      — OpenRouter multi-model (GPT-4o-mini → DeepSeek → Claude Haiku)
 *   DEEPSEEK_API_KEY        — DeepSeek direct API
 *   GEMINI_API_KEY          — Google Gemini 2.0 Flash direct
 *   XAI_API_KEY             — xAI Grok-4 (geo-blocked RU)
 *   ANTHROPIC_API_KEY       — Claude Haiku direct (geo-blocked RU)
 *   MINIMAX_API_KEY         — Minimax (резерв)
 *   NVIDIA_API_KEY          — NVIDIA NIM (Llama 3.3-70B, бесплатно)
 *   GROQ_API_KEY            — Groq (Llama 3.3-70B, бесплатно, US — проверить geo)
 *   CEREBRAS_API_KEY        — Cerebras (Llama 3.3-70B, бесплатно, US — проверить geo)
 *   MISTRAL_API_KEY         — Mistral La Plateforme (бесплатно, EU — проверить geo)
 *
 *   OPENROUTER_BASE_URL     — необязательно: релей вне РФ для openrouter.ai
 *                             (по умолчанию https://openrouter.ai/api/v1)
 *   ANTHROPIC_BASE_URL      — необязательно: релей вне РФ для api.anthropic.com
 *                             (по умолчанию https://api.anthropic.com)
 *
 * Бесплатные провайдеры инертны без ключа (getter→null→ноль сокетов в гонке).
 * US/EU-провайдеры (Groq/Cerebras/Mistral) могут геоблокировать РФ-IP Timeweb —
 * перед тем как полагаться, проверить достижимость через /api/ai/debug-waterfall.
 *
 * Гео-обход: openrouter.ai и api.anthropic.com блокируют РФ-IP — флагманы тогда
 * недостижимы, waterfall падает на DeepSeek/Gemini. Задать OPENROUTER_BASE_URL/
 * ANTHROPIC_BASE_URL на релей вне РФ (Cloudflare Worker/VPS) — и флагманы снова
 * в строю. Ключи и заголовки форвардит релей как есть.
 */

import type { ChatMessage } from '@/lib/ai/prompts';
import { getOpenRouterKey, getOpenRouterKeySource, getMiMoKey, getDeepSeekKey, getAnthropicKey, getXaiKey, getGeminiKey, getYandexKey, getMiniMaxKey, getGLMKey, getMuseSparkKey, getNvidiaKey, getFuguKey, getGroqKey, getCerebrasKey, getMistralKey } from '@/lib/ai/provider-config';
import { pool } from '@/lib/db-pool';
import { addUsage, currentAgentId } from '@/lib/ai/usage-context';

// ── Региональный релей (обход гео-блокировок RU) ──────────────────────────
// Timeweb-хостинг в РФ: openrouter.ai и api.anthropic.com гео-блокируют РФ-IP,
// из-за чего флагманы (Fable 5, Opus, GPT) недостижимы, и waterfall молча
// падает на DeepSeek/Gemini. Если задан релей вне РФ (Cloudflare Worker/VPS —
// прозрачный прокси, форвардит путь и Authorization как есть), базовые URL
// указывают на него. Переменные не заданы → прежнее прямое поведение.
const OPENROUTER_BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const ANTHROPIC_BASE  = (process.env.ANTHROPIC_BASE_URL  || 'https://api.anthropic.com').replace(/\/+$/, '');

// ── LLM usage tracking ────────────────────────────────────────
// Logs token counts and estimated costs to llm_usage_log (migration 686).
// Fire-and-forget — never throws, never blocks the caller.

interface ProviderUsage { prompt_tokens?: number; completion_tokens?: number }

const COST_PER_1K: Record<string, number> = {
  'deepseek-chat':                             0.00050,
  'deepseek/deepseek-chat-v3-0324':            0.00050,
  'anthropic/claude-fable-5':                  0.01500,
  'anthropic/claude-opus-4-8':                 0.01500,
  'anthropic/claude-haiku-4-5-20251001':       0.00025,
  'anthropic/claude-haiku-4-5':                0.00025,
  'openai/gpt-4o-mini':                        0.00040,
  'meta-llama/llama-3.3-70b-instruct':         0.00020,
  'gemini-2.0-flash':                          0.00010,
  'google/gemini-2.0-flash-001':               0.00010,
  'mimo-v2-pro':                               0.00010,
  'glm-5.1':                                   0.00030,
  'llama-3.3-70b-versatile':                   0,        // Groq free tier
  'llama-3.3-70b':                             0,        // Cerebras free tier
  'mistral-small-latest':                      0,        // Mistral free tier
};

function logLLMUsage(model: string, usage: ProviderUsage | undefined): void {
  if (!usage) return;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const total = prompt + completion;
  if (total === 0) return;
  const cost = ((COST_PER_1K[model] ?? 0.00050) * total) / 1000;
  // Атрибуция вызывающему агенту (Roitman §18.7.4) — no-op вне
  // runWithUsageTracking (обычные HTTP-запросы Кузьмича), agent_id тогда NULL.
  addUsage(prompt, completion, cost);
  pool.query(
    `INSERT INTO llm_usage_log
       (id, route, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, agent_id, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())`,
    [model, prompt, completion, total, cost, currentAgentId()],
  ).catch(() => { /* silent */ });
}

// ── Retry с exponential backoff + jitter (Roitman §18.7.1) ────
// Транзиентный 429/5xx или сетевой сбой у провайдера раньше выбивал модель
// из цепочки без повтора — падаем сразу на следующую, часто более дорогую.
// Ретраит ТОЛЬКО транзиентное: 429/500/502/503/504, ECONNRESET/ETIMEDOUT/
// "fetch failed". НЕ ретраит: 400 (кроме уже существующей safety-block ветки
// в callAnthropic — она вне этого хелпера, не трогаем), 401/403 (у OpenRouter
// уже есть markOpenRouterAuthFailure — не дублируем cooldown), 404, и
// AbortError от намеренного таймаута (это НЕ транзиентный сбой, а бюджет
// времени, который вызывающий код сам заложил).
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function isRetryableNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return false;
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed|network/i.test(err.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * fetch с ретраями транзиентных сбоев. timeoutMs задаётся отдельным
 * параметром (не через init.signal) — каждая попытка получает свежий
 * AbortSignal.timeout, а не урезанный остаток от предыдущей попытки.
 * Суммарный retry-бюджет по умолчанию (maxRetries=2, baseDelayMs=300) —
 * максимум ~1.5с сверх timeoutMs, что укладывается в ~1.5x даже для самых
 * коротких таймаутов в waterfall-цепочке (12с у openai/gpt-4o-mini).
 */
export async function fetchWithRetry(
  url: string,
  init: Omit<RequestInit, 'signal'>,
  opts: { timeoutMs: number; maxRetries?: number; baseDelayMs?: number; label?: string },
): Promise<Response> {
  const { timeoutMs, maxRetries = 2, baseDelayMs = 300, label } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const retryable = RETRYABLE_STATUS.has(res.status);
      if (res.ok || attempt === maxRetries || !retryable) {
        return res;
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt === maxRetries || !isRetryableNetworkError(err)) throw err;
      lastErr = err;
    }
    const delay = baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
    console.warn(`[ai:retry] ${label ?? url} retrying after ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
    await sleep(delay);
  }
  // Недостижимо (цикл всегда return/throw на attempt === maxRetries), но TS требует возврат.
  throw lastErr instanceof Error ? lastErr : new Error('fetchWithRetry: retries exhausted');
}

// ── Xiaomi MiMo-V2-Pro ────────────────────────────────────────
export async function callMiMo(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getMiMoKey();
  if (!apiKey) return null;

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetchWithRetry('https://api.xiaomimimo.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'mimo-v2-pro',
        temperature: 0.4,
        max_tokens: 800,
        messages: payload,
      }),
    }, { timeoutMs: 20_000, label: 'mimo' });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return null;
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    return null;
  }
}

// ── OpenRouter ─────────────────────────────────────────────────
// Пробует несколько моделей по очереди — защита от rate limit одной модели.
// Порядок: сначала быстрые и надёжные, timeout снижен до 12s
const OR_MODELS = [
  { id: 'anthropic/claude-fable-5',                     timeout: 20_000 }, // flagship
  { id: 'anthropic/claude-opus-4-8',                    timeout: 20_000 }, // flagship fallback (safety blocks)
  { id: 'anthropic/claude-haiku-4-5-20251001',          timeout: 15_000 }, // fast fallback
  { id: 'anthropic/claude-haiku-4-5',                   timeout: 15_000 }, // alias fallback
  { id: 'openai/gpt-4o-mini',                           timeout: 12_000 }, // non-anthropic backup
  { id: 'meta-llama/llama-3.3-70b-instruct',            timeout: 12_000 }, // free fallback
];

// If OpenRouter returns auth errors (401), avoid repeated slow failures.
// Only 401 triggers cooldown (bad key). 403 may be model-specific (geo-block, access).
const OPENROUTER_AUTH_COOLDOWN_MS = 5 * 60 * 1000;
let openRouterDisabledUntil = 0;

function isOpenRouterTemporarilyDisabled(): boolean {
  return Date.now() < openRouterDisabledUntil;
}

function markOpenRouterAuthFailure(): void {
  openRouterDisabledUntil = Date.now() + OPENROUTER_AUTH_COOLDOWN_MS;
}

function clearOpenRouterFailure(): void {
  openRouterDisabledUntil = 0;
}

/**
 * Диагностика ключа OpenRouter для health-эндпоинта: GET /api/v1/key —
 * бесплатный запрос (не тратит токены), различает 401 (ключ неверный),
 * лимиты/кредиты (в body) и сетевую недоступность с хостинга (timeout).
 * callOpenrouter такие детали глотает (catch → null) — по нему причину
 * падения провайдера снаружи не увидеть.
 */
export async function probeOpenRouterKeyStatus(): Promise<{
  key_source: 'OR_API_KEY' | 'OPENROUTER_API_KEY' | null;
  both_env_set: boolean;
  http_status: number | null;
  detail: string;
}> {
  const key_source = getOpenRouterKeySource();
  const both_env_set = !!process.env.OR_API_KEY && !!process.env.OPENROUTER_API_KEY;
  const apiKey = getOpenRouterKey();
  if (!apiKey) return { key_source, both_env_set, http_status: null, detail: 'ключ не задан' };

  try {
    const res = await fetch(`${OPENROUTER_BASE}/key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await res.text()).slice(0, 300);
    return { key_source, both_env_set, http_status: res.status, detail: body };
  } catch (e) {
    return {
      key_source,
      both_env_set,
      http_status: null,
      detail: `сеть/timeout: ${e instanceof Error ? e.message : 'error'}`,
    };
  }
}

export async function callOpenrouter(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getOpenRouterKey();
  if (!apiKey) return null;
  if (isOpenRouterTemporarilyDisabled()) return null;

  const payload = messages.map(({ role, content }) => ({ role, content }));

  for (const { id, timeout } of OR_MODELS) {
    try {
      const res = await fetchWithRetry(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://vedarai.ru',
          'X-Title': 'TourHab Kamchatka',
        },
        body: JSON.stringify({
          model: id,
          temperature: 0.4,
          max_tokens: 800,
          messages: payload,
        }),
      }, { timeoutMs: timeout, label: `openrouter:${id}` });

      if (!res.ok) {
        if (res.status === 401) {
          markOpenRouterAuthFailure();
          return null;
        }
        continue; // next model
      }

      clearOpenRouterFailure();
      const data = await res.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: ProviderUsage;
      };
      const text: string | undefined = data?.choices?.[0]?.message?.content;
      if (text?.trim()) {
        logLLMUsage(id, data.usage);
        return text;
      }
      // No valid content — try next model
    } catch { continue; }
  }

  return null;
}

// ── OpenRouter: specific model ────────────────────────────────
// Calls a single specific model via OpenRouter. Used for per-agent model assignment.

export interface OpenRouterModelOptions {
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  /** JSON Schema for structured outputs (supported by GPT-4.1, Gemini 2.5, etc.) */
  jsonSchema?: { name: string; strict?: boolean; schema: Record<string, unknown> };
}

export async function callOpenRouterModel(
  messages: ChatMessage[],
  modelId: string,
  timeoutOrOpts: number | OpenRouterModelOptions = 15_000,
): Promise<{ text: string; model_used: string } | null> {
  const opts: OpenRouterModelOptions = typeof timeoutOrOpts === 'number'
    ? { timeoutMs: timeoutOrOpts }
    : timeoutOrOpts;
  const { timeoutMs = 15_000, maxTokens = 800, temperature = 0.4, jsonMode = false, jsonSchema } = opts;

  const apiKey = getOpenRouterKey();
  if (!apiKey) return null;
  if (isOpenRouterTemporarilyDisabled()) return null;

  const payload = messages.map(({ role, content }) => ({ role, content }));

  try {
    const body: Record<string, unknown> = {
      model: modelId,
      temperature,
      max_tokens: maxTokens,
      messages: payload,
    };
    if (jsonSchema) {
      body.response_format = { type: 'json_schema', json_schema: jsonSchema };
    } else if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const res = await fetchWithRetry(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://vedarai.ru',
        'X-Title': 'Vedarai Kamchatka',
      },
      body: JSON.stringify(body),
    }, { timeoutMs, label: `openrouter-model:${modelId}` });

    if (!res.ok) {
      if (res.status === 401) {
        markOpenRouterAuthFailure();
      }
      return null;
    }

    clearOpenRouterFailure();
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data?.choices?.[0]?.message?.content;
    if (!text?.trim()) return null;
    return { text: text.trim(), model_used: modelId };
  } catch {
    return null;
  }
}

// ── OpenRouter: Function calling (tools) ──────────────────────

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolsCallResult {
  content: string | null;
  tool_calls: ToolCall[] | null;
}

type ToolMsg =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

export async function callOpenRouterWithTools(
  messages: ToolMsg[],
  tools: ToolDefinition[],
  modelId = 'openai/gpt-4o-mini',
  timeoutMs = 20_000,
): Promise<ToolsCallResult | null> {
  const apiKey = getOpenRouterKey();
  if (!apiKey || isOpenRouterTemporarilyDisabled()) return null;

  try {
    const res = await fetchWithRetry(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://vedarai.ru',
        'X-Title': 'Vedarai Kamchatka',
      },
      body: JSON.stringify({
        model: modelId,
        temperature: 0.3,
        max_tokens: 1000,
        messages,
        tools,
        tool_choice: 'auto',
      }),
    }, { timeoutMs, label: `openrouter-tools:${modelId}` });

    if (!res.ok) {
      if (res.status === 401) markOpenRouterAuthFailure();
      return null;
    }

    clearOpenRouterFailure();
    const data = await res.json() as {
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: string | null; tool_calls?: ToolCall[] };
      }>;
    };

    const msg = data?.choices?.[0]?.message;
    if (!msg) return null;

    return {
      content: msg.content ?? null,
      tool_calls: msg.tool_calls?.length ? msg.tool_calls : null,
    };
  } catch {
    return null;
  }
}

// DeepSeek tool-calling (OpenAI-совместимый function-calling). Используется как
// фоллбэк tools-цикла, когда OpenRouter недоступен — например, регион-блокирует
// IP хостинга (403 "Access denied by security policy"): замена ключа не помогает,
// а DeepSeek с российского хостинга доступен.
export async function callDeepSeekWithTools(
  messages: ToolMsg[],
  tools: ToolDefinition[],
  modelId = 'deepseek-chat',
  timeoutMs = 25_000,
): Promise<ToolsCallResult | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetchWithRetry('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        temperature: 0.3,
        max_tokens: 1000,
        messages,
        tools,
        tool_choice: 'auto',
      }),
    }, { timeoutMs, label: `deepseek-tools:${modelId}` });

    if (!res.ok) return null;

    const data = await res.json() as {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: ToolCall[] };
      }>;
    };
    const msg = data?.choices?.[0]?.message;
    if (!msg) return null;

    return {
      content: msg.content ?? null,
      tool_calls: msg.tool_calls?.length ? msg.tool_calls : null,
    };
  } catch {
    return null;
  }
}

// Qwen tool-calling (OpenAI-совместимый, Alibaba DashScope). Первичный
// провайдер tools-цикла: доступен из РФ (китайский, как DeepSeek), сильный
// агентный function-calling. База/модель — из env.
export async function callQwenWithTools(
  messages: ToolMsg[],
  tools: ToolDefinition[],
  timeoutMs = 25_000,
): Promise<ToolsCallResult | null> {
  const { apiKey, base, model } = getQwenConfig();
  if (!apiKey) return null;

  try {
    const res = await fetchWithRetry(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 1000,
        messages,
        tools,
        tool_choice: 'auto',
      }),
    }, { timeoutMs, label: `qwen-tools:${model}` });

    if (!res.ok) return null;

    const data = await res.json() as {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: ToolCall[] };
      }>;
    };
    const msg = data?.choices?.[0]?.message;
    if (!msg) return null;

    return {
      content: msg.content ?? null,
      tool_calls: msg.tool_calls?.length ? msg.tool_calls : null,
    };
  } catch {
    return null;
  }
}

/** Первый непустой результат из списка попыток; поздние не зовём после успеха. */
export async function firstNonNullTool(
  attempts: Array<() => Promise<ToolsCallResult | null>>,
): Promise<ToolsCallResult | null> {
  for (const attempt of attempts) {
    const r = await attempt();
    if (r) return r;
  }
  return null;
}

// Водопад инструментов: Qwen (первичный — качество + доступен из РФ) → DeepSeek
// (рабочий фоллбэк) → OpenRouter (последний шанс, авто-восстановление если
// разблокируют). Раньше tools-цикл Кузьмича висел только на OpenRouter — при
// регион-блоке инструменты отваливались, чат жил без tools.
export async function callToolsWaterfall(
  messages: ToolMsg[],
  tools: ToolDefinition[],
): Promise<ToolsCallResult | null> {
  return firstNonNullTool([
    () => callQwenWithTools(messages, tools),        // первичный: качество + доступен из РФ
    () => callDeepSeekWithTools(messages, tools),    // фоллбэк
    () => callOpenRouterWithTools(messages, tools),  // последний шанс (авто-восстановление если разблокируют)
  ]);
}

// Call AI with a preferred model. Falls back to full waterfall if preferred model fails.
export async function callAIWithModel(
  messages: ChatMessage[],
  preferredModel?: string | null,
  opts?: OpenRouterModelOptions,
): Promise<{ text: string; model_used: string }> {
  if (preferredModel) {
    const result = await callOpenRouterModel(messages, preferredModel, opts ?? 15_000);
    if (result) return result;
  }
  const text = await callAIWaterfall(messages);
  return { text, model_used: 'waterfall-fallback' };
}

// ── Minimax ────────────────────────────────────────────────────
export async function callMinimax(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) return null;

  try {
    const systemMsg = messages.find(m => m.role === 'system');
    const turns = messages.filter(m => m.role !== 'system');
    const payload = turns.map(({ role, content }) => ({
      role: role === 'assistant' ? 'assistant' : 'user',
      content,
    }));

    const res = await fetch('https://api.minimaxi.chat/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'MiniMax-Text-01',
        temperature: 0.4,
        max_tokens: 800,
        ...(systemMsg ? { system_prompt: systemMsg.content } : {}),
        messages: payload,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return null;
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    return null;
  }
}

// ── xAI (Grok) ────────────────────────────────────────────────
export async function callXai(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getXaiKey();
  if (!apiKey) return null;

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-4',
        temperature: 0.4,
        max_tokens: 800,
        messages: payload,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return null;
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    return null;
  }
}

// ── Anthropic Claude (direct API) ───────────────────────────

// Marker to split a system message into cached prefix + uncached dynamic suffix.
// Callers append "\n\n<<<CACHE_BREAK>>>\n\n" between the static (cacheable) part
// and the dynamic (per-request) part. Without the marker, the whole system
// message is cached as a single block (existing behavior preserved).
export const CACHE_BREAK_MARKER = '<<<CACHE_BREAK>>>';

function buildSystemBlocks(systemContent: string): Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> {
  const sep = `\n\n${CACHE_BREAK_MARKER}\n\n`;
  const idx = systemContent.indexOf(sep);
  if (idx < 0) {
    return [{ type: 'text', text: systemContent, cache_control: { type: 'ephemeral' } }];
  }
  const cached = systemContent.slice(0, idx);
  const dynamic = systemContent.slice(idx + sep.length);
  const blocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [];
  if (cached) blocks.push({ type: 'text', text: cached, cache_control: { type: 'ephemeral' } });
  if (dynamic) blocks.push({ type: 'text', text: dynamic });
  return blocks;
}

export async function callAnthropic(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getAnthropicKey();
  if (!apiKey) return null;

  try {
    const systemMsg = messages.find(m => m.role === 'system');
    const turns = messages.filter(m => m.role !== 'system');
    const firstUserIdx = turns.findIndex(m => m.role === 'user');
    const clean = firstUserIdx >= 0 ? turns.slice(firstUserIdx) : turns;
    const window = clean.slice(-6);
    const startIdx = window.findIndex(m => m.role === 'user');
    const trimmed = startIdx > 0 ? window.slice(startIdx) : window;

    if (!trimmed.length) return null;

    const anthropicMessages = trimmed.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const res = await fetchWithRetry(`${ANTHROPIC_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? 'claude-fable-5',
        max_tokens: 800,
        temperature: 0.4,
        ...(systemMsg ? { system: buildSystemBlocks(systemMsg.content) } : {}),
        messages: anthropicMessages,
      }),
    }, { timeoutMs: 20_000, label: 'anthropic' });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      // Fable 5 safety classifier blocks (400) — retry with Opus 4.8
      if (res.status === 400 && errText.includes('safety') && (process.env.ANTHROPIC_MODEL ?? 'claude-fable-5') === 'claude-fable-5') {
        const fb = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 800, temperature: 0.4, ...(systemMsg ? { system: [{ type: 'text', text: systemMsg.content }] } : {}), messages: anthropicMessages }),
          signal: AbortSignal.timeout(20_000),
        }).catch(() => null);
        if (fb?.ok) {
          const fd: unknown = await fb.json().catch(() => null);
          if (fd && typeof fd === 'object' && 'content' in fd) {
            const fc = (fd as { content: Array<Record<string, unknown>> }).content;
            return typeof fc[0]?.text === 'string' ? fc[0].text : null;
          }
        }
      }
      return null;
    }

    const data: unknown = await res.json();
    if (
      data !== null &&
      typeof data === 'object' &&
      'content' in data &&
      Array.isArray((data as Record<string, unknown>).content)
    ) {
      const content = (data as { content: Array<Record<string, unknown>> }).content;
      const item = content[0];
      return typeof item?.text === 'string' ? item.text : null;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ── YandexGPT Lite (Yandex Cloud) ─────────────────────────────
// Лучший по русскому языку. Без геоблока для России.
// Env: YANDEX_API_KEY (Api-Key), YANDEX_FOLDER_ID (каталог YC)
export async function callYandexGPT(messages: ChatMessage[]): Promise<string | null> {
  const yandex = getYandexKey();
  if (!yandex) return null;
  const { apiKey, folderId } = yandex;

  try {
    // YandexGPT использует `text` вместо `content`
    const yMessages = messages
      .filter((m) => m.role !== 'system')
      .map(({ role, content }) => ({
        role: role === 'assistant' ? 'assistant' : 'user',
        text: content,
      }));

    const systemMsg = messages.find((m) => m.role === 'system');
    if (systemMsg) {
      yMessages.unshift({ role: 'system', text: systemMsg.content });
    }

    const res = await fetch(
      'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Api-Key ${apiKey}`,
          'x-folder-id': folderId,
        },
        body: JSON.stringify({
          modelUri: `gpt://${folderId}/yandexgpt-5.1/latest`,
          completionOptions: {
            stream: false,
            temperature: 0.4,
            maxTokens: '800',
          },
          messages: yMessages,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!res.ok) return null;
    const data = await res.json();
    const text: string | undefined =
      data?.result?.alternatives?.[0]?.message?.text;
    return text?.trim() || null;
  } catch {
    return null;
  }
}

// ── Google Gemini (via OpenRouter) ────────────────────────────
export async function callGemini(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getOpenRouterKey();
  if (!apiKey) return null;

  try {
    const systemMsg = messages.find(m => m.role === 'system');
    const turns = messages.filter(m => m.role !== 'system');
    const payload = turns.map(({ role, content }) => ({
      role: role === 'assistant' ? 'assistant' : 'user',
      content,
    }));

    if (systemMsg) {
      payload.unshift({ role: 'user', content: `[System]: ${systemMsg.content}` });
    }

    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://vedarai.ru',
        'X-Title': 'Vedarai Kamchatka',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-lite',
        temperature: 0.4,
        max_tokens: 1200,
        messages: payload,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

// ── DeepSeek (direct API) ──────────────────────────────────────
export async function callDeepSeek(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getDeepSeekKey();
  if (!apiKey) return null;

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetchWithRetry('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.4,
        max_tokens: 800,
        messages: payload,
      }),
    }, { timeoutMs: 20_000, label: 'deepseek' });
    if (!res.ok) return null;
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: ProviderUsage;
    };
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    if (text?.trim()) {
      logLLMUsage('deepseek-chat', data.usage);
      return text;
    }
    return null;
  } catch { return null; }
}

// ── Qwen (Alibaba DashScope — OpenAI-совместимый) ─────────────
// Китайский провайдер, доступен из РФ (как DeepSeek), сильный агентный
// tool-calling. База и модель — из env: QWEN_BASE_URL (default
// dashscope-intl — интернациональный шлюз), QWEN_MODEL (default qwen-plus).
// Сменить регион-шлюз или тир (qwen-plus/qwen-max) — без правки кода.
export function getQwenConfig(): { apiKey: string | null; base: string; model: string } {
  return {
    apiKey: process.env.DASHSCOPE_API_KEY || null,
    base: (process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
    model: process.env.QWEN_MODEL || 'qwen-plus',
  };
}

export async function callQwen(messages: ChatMessage[]): Promise<string | null> {
  const { apiKey, base, model } = getQwenConfig();
  if (!apiKey) return null;

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetchWithRetry(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 800,
        messages: payload,
      }),
    }, { timeoutMs: 25_000, label: `qwen:${model}` });
    if (!res.ok) return null;
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: ProviderUsage;
    };
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    if (text?.trim()) {
      logLLMUsage(`qwen:${model}`, data.usage);
      return text;
    }
    return null;
  } catch { return null; }
}

// Диагностика ПРИЧИНЫ, почему callQwen молчит: реальный POST в
// /chat/completions с настроенной моделью. 401/403 = ключ, 404 = не та
// модель, conn/timeout = база или RF-блок хоста.
export async function probeQwenKeyStatus(): Promise<{
  key_set: boolean;
  base: string;
  model: string;
  http_status: number | null;
  detail: string;
}> {
  const { apiKey, base, model } = getQwenConfig();
  if (!apiKey) return { key_set: false, base, model, http_status: null, detail: 'ключ не задан' };

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.text()).slice(0, 300);
    return { key_set: true, base, model, http_status: res.status, detail: body };
  } catch (e) {
    return {
      key_set: true,
      base,
      model,
      http_status: null,
      detail: `сеть/timeout: ${e instanceof Error ? e.message : 'error'}`,
    };
  }
}

// ── GLM 5.1 (ZhipuAI direct API — bigmodel.cn) ────────────────
// ZhipuAI OpenAI-compatible endpoint. Env: GLM_API_KEY
export async function callGLM(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getGLMKey();
  if (!apiKey) return null;

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'glm-5.1',
        temperature: 0.4,
        max_tokens: 800,
        messages: payload,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    return text?.trim() || null;
  } catch { return null; }
}

// ── NVIDIA NIM (OpenAI-compatible, 100+ моделей бесплатно) ────
// Docs: https://build.nvidia.com — Free tier, OpenAI API format
// Модель: meta/llama-3.3-70b-instruct (сильная, быстрая, бесплатно)
// Env: NVIDIA_API_KEY
export async function callNvidia(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getNvidiaKey();
  if (!apiKey) return null;

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'meta/llama-3.3-70b-instruct',
        temperature: 0.4,
        max_tokens: 800,
        messages: payload,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    return text?.trim() || null;
  } catch { return null; }
}

// ── Groq (OpenAI-compatible, Llama 3.3-70B бесплатно, очень быстрый LPU) ──
// Docs: https://console.groq.com — Free tier, OpenAI API format
// Env: GROQ_API_KEY. Инертна без ключа. GEO: US — проверить достижимость с РФ-IP.
const GROQ_MODEL = 'llama-3.3-70b-versatile';
export async function callGroq(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getGroqKey();
  if (!apiKey) return null;

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.4,
        max_tokens: 800,
        messages: payload,
      }),
    }, { timeoutMs: 15_000, label: 'groq' });
    if (!res.ok) return null;
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: ProviderUsage;
    };
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    if (text?.trim()) {
      logLLMUsage(GROQ_MODEL, data.usage);
      return text.trim();
    }
    return null;
  } catch { return null; }
}

// ── Cerebras (OpenAI-compatible, Llama 3.3-70B бесплатно, экстремально быстрый) ──
// Docs: https://cloud.cerebras.ai — Free tier, OpenAI API format
// Env: CEREBRAS_API_KEY. Инертна без ключа. GEO: US — проверить достижимость.
const CEREBRAS_MODEL = 'llama-3.3-70b';
export async function callCerebras(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getCerebrasKey();
  if (!apiKey) return null;

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetchWithRetry('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: CEREBRAS_MODEL,
        temperature: 0.4,
        max_tokens: 800,
        messages: payload,
      }),
    }, { timeoutMs: 15_000, label: 'cerebras' });
    if (!res.ok) return null;
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: ProviderUsage;
    };
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    if (text?.trim()) {
      logLLMUsage(CEREBRAS_MODEL, data.usage);
      return text.trim();
    }
    return null;
  } catch { return null; }
}

// ── Mistral La Plateforme (OpenAI-compatible, mistral-small бесплатно) ──
// Docs: https://console.mistral.ai — Free tier (opt-in), OpenAI API format
// Env: MISTRAL_API_KEY. Инертна без ключа. GEO: EU — проверить достижимость.
const MISTRAL_MODEL = 'mistral-small-latest';
export async function callMistral(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getMistralKey();
  if (!apiKey) return null;

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetchWithRetry('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        temperature: 0.4,
        max_tokens: 800,
        messages: payload,
      }),
    }, { timeoutMs: 15_000, label: 'mistral' });
    if (!res.ok) return null;
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: ProviderUsage;
    };
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    if (text?.trim()) {
      logLLMUsage(MISTRAL_MODEL, data.usage);
      return text.trim();
    }
    return null;
  } catch { return null; }
}

// ── MiniMax 2.5 (direct API) ─────────────────────────────────
export async function callMiniMax(messages: ChatMessage[]): Promise<string | null> {
  const keys = getMiniMaxKey();
  if (!keys) return null;

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetch(
      `https://api.minimax.chat/v1/text/chatcompletion_v2?GroupId=${keys.groupId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keys.apiKey}`,
        },
        body: JSON.stringify({
          model: 'MiniMax-Text-01',
          temperature: 0.4,
          max_tokens: 800,
          messages: payload,
        }),
        signal: AbortSignal.timeout(20_000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    return text?.trim() || null;
  } catch { return null; }
}

// ── Google Gemini (direct API) ─────────────────────────────────
export async function callGeminiDirect(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getGeminiKey();
  if (!apiKey) return null;

  try {
    const systemMsg = messages.find(m => m.role === 'system');
    const turns = messages.filter(m => m.role !== 'system');
    const contents = turns.map(({ role, content }) => ({
      role: role === 'assistant' ? 'model' : 'user',
      parts: [{ text: content }],
    }));

    const body: Record<string, unknown> = { contents };
    if (systemMsg) {
      body.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }

    const res = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      { timeoutMs: 20_000, label: 'gemini-direct' },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text?.trim() || null;
  } catch { return null; }
}

// ── Gemini Vision (image analysis): нативный Gemini → OpenRouter ─────────────
// Приоритет 1 — нативный Google Gemini API (GEMINI_API_KEY): не зависит от
// OpenRouter, поэтому фото читается даже если ключ/модель OpenRouter отвалились
// (именно из-за OpenRouter-only Кузьмич «перестал узнавать фото»).
// Приоритет 2 — тот же Gemini через OpenRouter (как было).
export async function callGeminiVision(
  imageBase64: string,
  mimeType: string,
  prompt: string,
): Promise<string | null> {
  const systemHint = 'Ты — эксперт по природе и достопримечательностям Камчатки. Отвечай на русском, кратко и точно. Определяй вулканы, животных, растения, локации.';

  // Приоритет 1: нативный Gemini API.
  const geminiKey = getGeminiKey();
  if (geminiKey) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemHint }] },
            contents: [{
              parts: [
                { inline_data: { mime_type: mimeType, data: imageBase64 } },
                { text: prompt },
              ],
            }],
            generationConfig: { maxOutputTokens: 600 },
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (res.ok) {
        const data = await res.json();
        const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text?.trim()) return text.trim();
      }
    } catch { /* переходим на OpenRouter */ }
  }

  // Приоритет 2 (fallback): Gemini через OpenRouter.
  const apiKey = getOpenRouterKey();
  if (!apiKey) return null;

  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://vedarai.ru',
        'X-Title': 'Vedarai Kamchatka',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-001',
        max_tokens: 600,
        messages: [
          {
            role: 'system',
            content: 'Ты — эксперт по природе и достопримечательностям Камчатки. Отвечай на русском, кратко и точно. Определяй вулканы, животных, растения, локации.',
          },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    return text?.trim() || null;
  } catch { return null; }
}

// ── Gemini Audio Transcription via OpenRouter ──────────────────
// Поддерживает: audio/ogg, audio/mp3, audio/wav, audio/m4a (Telegram шлёт ogg)
// Фразы-признаки того что модель не смогла обработать аудио (не реальная транскрипция)
const TRANSCRIBE_FAIL_PATTERNS = [
  /не могу обработать/i, /cannot process/i, /unable to process/i,
  /audio file/i, /аудиофайл/i, /не поддерживает/i, /не поддерживаю/i,
  /i can't/i, /i cannot/i, /no audio/i, /нет аудио/i,
  /audio content/i, /audio data/i,
];

export async function callGeminiTranscribe(
  audioBase64: string,
  mimeType: string = 'audio/ogg',
): Promise<string | null> {
  const apiKey = getOpenRouterKey();
  if (!apiKey) return null;

  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://vedarai.ru',
        'X-Title': 'Vedarai Kamchatka',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-001',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            // Gemini принимает аудио через image_url с audio MIME-type
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${audioBase64}` } },
            { type: 'text', text: 'Это голосовое сообщение на русском языке. Транскрибируй дословно. Только текст без пояснений. Если неразборчиво — "(неразборчиво)".' },
          ],
        }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    if (!text?.trim()) return null;
    // Если модель вернула отказ обработать аудио — не показываем мусор пользователю
    if (TRANSCRIBE_FAIL_PATTERNS.some(p => p.test(text))) return null;
    return text.trim();
  } catch { return null; }
}

// ── Gemini PDF Extraction via OpenRouter ──────────────────────
// Принимает PDF как base64, возвращает текст с извлечёнными данными.
// Используется для импорта туров из PDF-документов операторов.
export async function callGeminiPDF(
  pdfBase64: string,
  prompt: string,
): Promise<string | null> {
  // Приоритет 1: нативный Google Gemini API (стабилен с сервера, нативно читает PDF).
  const geminiKey = getGeminiKey();
  if (geminiKey) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
                { text: prompt },
              ],
            }],
          }),
          signal: AbortSignal.timeout(45_000),
        },
      );
      if (res.ok) {
        const data = await res.json();
        const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text?.trim()) return text.trim();
      }
    } catch { /* fall through to OpenRouter */ }
  }

  // Приоритет 2 (fallback): тот же Gemini через OpenRouter.
  const apiKey = getOpenRouterKey();
  if (!apiKey) return null;
  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://vedarai.ru',
        'X-Title': 'Vedarai Kamchatka',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-001',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                file: { filename: 'passport.pdf', file_data: `data:application/pdf;base64,${pdfBase64}` },
              },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    return text?.trim() || null;
  } catch { return null; }
}

// ── Preflight: быстрая проверка доступности провайдеров ──────
// Минимальный запрос к каждому провайдеру, параллельно, 5s timeout
export interface ProviderStatus {
  id: string;
  name: string;
  available: boolean;
  latency_ms?: number;
  error?: string;
}

export interface OpenRouterBalance {
  total_credits: number;
  total_usage: number;
  remaining: number | null; // null = pay-as-you-go (no limit)
  low: boolean;
}

/**
 * Проверяет баланс OpenRouter.
 *
 * Приоритет:
 *   1. OPENROUTER_MANAGEMENT_KEY → /api/v1/credits  (точный баланс, management key)
 *   2. OPENROUTER_API_KEY        → /api/v1/auth/key  (usage/limit, стандартный ключ)
 *
 * Добавь в Timeweb env:
 *   OPENROUTER_MANAGEMENT_KEY=sk-or-v1-mgmt-...
 */
export async function checkOpenRouterBalance(): Promise<OpenRouterBalance | null> {
  const mgmtKey = process.env.OPENROUTER_MANAGEMENT_KEY;
  const apiKey  = getOpenRouterKey();

  // ── Вариант 1: management key → /api/v1/credits ──────────────
  if (mgmtKey) {
    try {
      const res = await fetch(`${OPENROUTER_BASE}/credits`, {
        headers: { Authorization: `Bearer ${mgmtKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const json = await res.json() as {
          data: { total_credits: number; total_usage: number }
        };
        const { total_credits, total_usage } = json.data;
        const remaining = Math.round((total_credits - total_usage) * 100) / 100;
        return {
          total_credits: Math.round(total_credits * 100) / 100,
          total_usage:   Math.round(total_usage   * 100) / 100,
          remaining,
          low: remaining < 0.5,
        };
      }
    } catch { /* fallthrough */ }
  }

  // ── Вариант 2: стандартный API key → /api/v1/auth/key ────────
  if (!apiKey) return null;
  try {
    const res = await fetch(`${OPENROUTER_BASE}/auth/key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = await res.json() as {
      data: { usage: number; limit: number | null }
    };
    const { usage, limit } = json.data;
    // OR returns limit=999 as sentinel for "no hard limit" (pay-as-you-go)
    const effectiveLimit = limit != null && limit < 999 ? limit : null;
    const remaining = effectiveLimit != null ? Math.round((effectiveLimit - usage) * 100) / 100 : null;
    return {
      total_credits: effectiveLimit ?? 0,
      total_usage:   Math.round(usage * 100) / 100,
      remaining,     // null = pay-as-you-go, no hard limit
      low:           remaining != null && remaining < 0.5,
    };
  } catch {
    return null;
  }
}

export async function preflightProviders(): Promise<{
  providers: ProviderStatus[];
  any_available: boolean;
  openrouter_balance: OpenRouterBalance | null;
}> {
  const testMsg: ChatMessage[] = [{ role: 'user', content: 'ok' }];

  // Пробует провайдера и возвращает подробный статус (HTTP-код + тело ошибки)
  async function probeDetailed(
    id:     string,
    name:   string,
    fn:     () => Promise<{ ok: boolean; status?: number; error?: string }>,
  ): Promise<ProviderStatus> {
    const start = Date.now();
    try {
      const result = await Promise.race([
        fn(),
        new Promise<{ ok: boolean; error: string }>((resolve) =>
          setTimeout(() => resolve({ ok: false, error: 'timeout 5s' }), 5000),
        ),
      ]);
      return {
        id,
        name,
        available:  result.ok,
        latency_ms: Date.now() - start,
        error:      result.ok ? undefined : result.error,
      };
    } catch (e) {
      return { id, name, available: false, latency_ms: Date.now() - start, error: String(e) };
    }
  }

  async function probeMiMo() {
    const apiKey = process.env.XIAOMI_API_KEY;
    if (!apiKey) return { ok: false, error: 'XIAOMI_API_KEY not set' };
    try {
      const res = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'mimo-v2-pro', max_tokens: 5, messages: testMsg }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function probeOpenrouter() {
    const apiKey = getOpenRouterKey();
    if (!apiKey) return { ok: false, error: 'OPENROUTER_API_KEY not set' };
    try {
      const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://vedarai.ru',
          'X-Title': 'TourHab Kamchatka',
        },
        body: JSON.stringify({ model: 'openai/gpt-4o-mini', max_tokens: 5, messages: testMsg }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function probeDeepSeek() {
    const apiKey = getDeepSeekKey();
    if (!apiKey) return { ok: false, error: 'DEEPSEEK_API_KEY not set' };
    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 5, messages: testMsg }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function probeXai() {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: false, error: 'XAI_API_KEY not set' };
    try {
      const res = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'grok-4', max_tokens: 5, messages: testMsg }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function probeFugu() {
    const apiKey = getFuguKey();
    if (!apiKey) return { ok: false, error: 'FUGU_API_KEY not set' };
    let base = (process.env.FUGU_BASE_URL || 'https://api.sakana.ai').replace(/\/+$/, '');
    if (!base.endsWith('/v1')) base = `${base}/v1`;
    const model = process.env.FUGU_MODEL || 'fugu';
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, max_completion_tokens: 5, messages: testMsg }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function probeGroq() {
    const apiKey = getGroqKey();
    if (!apiKey) return { ok: false, error: 'GROQ_API_KEY not set' };
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: GROQ_MODEL, max_tokens: 5, messages: testMsg }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function probeCerebras() {
    const apiKey = getCerebrasKey();
    if (!apiKey) return { ok: false, error: 'CEREBRAS_API_KEY not set' };
    try {
      const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: CEREBRAS_MODEL, max_tokens: 5, messages: testMsg }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function probeMistral() {
    const apiKey = getMistralKey();
    if (!apiKey) return { ok: false, error: 'MISTRAL_API_KEY not set' };
    try {
      const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: MISTRAL_MODEL, max_tokens: 5, messages: testMsg }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function probeAnthropic() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY not set' };
    try {
      const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'ok' }],
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  const [providers, openrouter_balance] = await Promise.all([
    Promise.all([
      probeDetailed('mimo',       'MiMo-V2-Pro (Xiaomi)',        probeMiMo),
      probeDetailed('openrouter', 'OpenRouter (GPT-4o-mini)',     probeOpenrouter),
      probeDetailed('deepseek',   'DeepSeek-V3 (DeepSeek)',       probeDeepSeek),
      probeDetailed('fugu',       'Sakana Fugu',                  probeFugu),
      probeDetailed('groq',       'Groq (Llama 3.3-70B)',         probeGroq),
      probeDetailed('cerebras',   'Cerebras (Llama 3.3-70B)',     probeCerebras),
      probeDetailed('mistral',    'Mistral (small)',              probeMistral),
    ]),
    checkOpenRouterBalance(),
  ]);

  return {
    providers,
    any_available: providers.some(p => p.available),
    openrouter_balance,
  };
}

// ── Race Helper: first non-empty result from parallel calls ──────
async function raceProviders(calls: Promise<string | null>[]): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let pending = calls.length;
    if (pending === 0) { resolve(null); return; }
    let settled = false;
    calls.forEach(p =>
      p.then(result => {
        if (!settled && result?.trim()) { settled = true; resolve(result); }
      }).catch(() => {}).finally(() => {
        pending--;
        if (pending === 0 && !settled) resolve(null);
      })
    );
  });
}

// ── Meta Muse Spark ───────────────────────────────────────────
// Анонсирована 08.04.2026. API пока закрыт (select partners).
// Активируется автоматически при выставлении MUSE_SPARK_API_KEY в Timeweb.
// Нативно мультимодальная, Contemplating mode (multi-agent reasoning).
// Ожидаемый endpoint — meta.ai OpenAI-compatible API (уточнить при открытии).
export async function callMuseSpark(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getMuseSparkKey();
  if (!apiKey) return null; // API ещё закрыт — пропускаем без ошибки

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    // Endpoint уточнить когда Meta откроет публичный API
    const res = await fetch('https://api.meta.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'muse-spark',
        temperature: 0.4,
        max_tokens: 800,
        messages: payload,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) return null;
    const data = await res.json();
    return (data?.choices?.[0]?.message?.content as string) ?? null;
  } catch {
    return null;
  }
}

// ── Sakana AI Fugu ──────────────────────────────────────────
// OpenAI-compatible API (Chat Completions). Ключ FUGU_API_KEY (формат fish_...).
// Base URL настраивается через FUGU_BASE_URL (по докам Sakana), дефолт api.sakana.ai.
// Модель: FUGU_MODEL (fugu — быстрая дефолтная / fugu-ultra — максимум качества).
export async function callFugu(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getFuguKey();
  if (!apiKey) return null;

  // База: FUGU_BASE_URL, нормализуем до .../v1
  let base = (process.env.FUGU_BASE_URL || 'https://api.sakana.ai').replace(/\/+$/, '');
  if (!base.endsWith('/v1')) base = `${base}/v1`;
  const model = process.env.FUGU_MODEL || 'fugu';

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: 800,  // fugu-ultra: лимит только на финальный ответ
        messages: payload,
      }),
      signal: AbortSignal.timeout(45_000),  // ultra оркеструет несколько агентов — дольше
    });

    if (!res.ok) return null;
    const data = await res.json();
    return (data?.choices?.[0]?.message?.content as string) ?? null;
  } catch {
    return null;
  }
}

// ── Waterfall: race tiers for speed ─────────────────────────
// Tier 1: OpenRouter + DeepSeek + Gemini + MiMo + MuseSpark — race (кто быстрее)
// Tier 2: Yandex + MiniMax — fallback
// Tier 3: Anthropic — sequential fallback
//
// Fugu Ultra сюда сознательно НЕ включена: raceProviders() не отменяет
// проигравшие вызовы — они дожидаются полного ответа в фоне и всё равно
// тарифицируются. Оркестрация Fugu Ultra стоит ~1260 токенов оверхеда на
// запрос и отвечает за ~20с против 2-8с у остальных Tier 1 — она проигрывает
// гонку почти всегда, но деньги списываются каждый раз. Fugu используется
// точечно там, где задержка не важна: lib/agents/editor.ts (A/B вариант B,
// прямой callFugu()) и app/api/admin/test-fugu (ручная проверка).
export async function callAIWaterfall(messages: ChatMessage[]): Promise<string> {
  // Tier 1: race all primary providers simultaneously.
  // MiMo (прямой api.xiaomimimo.com) отключён 04.07.2026 — эндпоинт не отвечал
  // (health WARN), а в гонке он лишь тратил соединение и шумел в мониторинге.
  // Если MiMo снова понадобится — вернуть через OpenRouter (модель-id в OR_MODELS),
  // а не прямым вызовом Xiaomi. Функция callMiMo оставлена для этого.
  const tier1 = await raceProviders([
    callOpenrouter(messages),
    callDeepSeek(messages),
    callGeminiDirect(messages),
    callGLM(messages),
    callNvidia(messages),    // NVIDIA NIM: Llama 3.3-70B бесплатно (NVIDIA_API_KEY)
    callGroq(messages),      // Groq: Llama 3.3-70B бесплатно (GROQ_API_KEY, US — проверить geo)
    callCerebras(messages),  // Cerebras: Llama 3.3-70B бесплатно (CEREBRAS_API_KEY, US — проверить geo)
    callMistral(messages),   // Mistral: mistral-small бесплатно (MISTRAL_API_KEY, EU — проверить geo)
    callMuseSpark(messages), // активируется когда Meta откроет API (MUSE_SPARK_API_KEY)
  ]);
  if (tier1) return tier1;

  // Tier 2: race mid-tier fallbacks
  const tier2 = await raceProviders([
    callYandexGPT(messages),
    callMiniMax(messages),
  ]);
  if (tier2) return tier2;

  // Tier 3: sequential fallback (rarely reached)
  const anthropic = await callAnthropic(messages);
  if (anthropic) return anthropic;

  // All providers failed — log for Timeweb server diagnostics
  console.error('[AI] All providers failed. Configured keys:', {
    OR: !!getOpenRouterKey(),
    DeepSeek: !!process.env.DEEPSEEK_API_KEY,
    Gemini: !!process.env.GEMINI_API_KEY,
    Anthropic: !!process.env.ANTHROPIC_API_KEY,
    Yandex: !!(process.env.YANDEX_API_KEY && process.env.YANDEX_FOLDER_ID),
    MiniMax: !!(process.env.MINIMAX_API_KEY && process.env.MINIMAX_GROUP_ID),
    OR_disabled_until: openRouterDisabledUntil > 0 ? new Date(openRouterDisabledUntil).toISOString() : 'none',
  });
  return 'Извините, сервис временно недоступен. Попробуйте позже.';
}

// Sentinel-строки фолбэков waterfall/fast: при отказе всех провайдеров
// возвращается строка, а не исключение. Роуты ОБЯЗАНЫ проверять ответ этим
// хелпером, иначе ошибка уедет клиенту как обычный текст со статусом 200 —
// у AI Спасателя это прятало локальный протокол выживания (issue #27).
const WATERFALL_ERROR_PREFIXES = [
  'Извините, сервис временно недоступен',
  'Сервис временно недоступен',
];

export function isWaterfallErrorResponse(text: string): boolean {
  return WATERFALL_ERROR_PREFIXES.some(p => text.startsWith(p));
}

// ── Fast Waterfall — race cheap providers ────────────────────
// Для структурированных задач (JSON, бинарные ответы, голосование).
// Races DeepSeek + MiMo + Gemini simultaneously.
export async function callAIFast(messages: ChatMessage[]): Promise<string> {
  const apiKey = getOpenRouterKey();

  // MiMo убран 04.07.2026 — прямой api.xiaomimimo.com не отвечал (см. callAIWaterfall).
  const calls: Promise<string | null>[] = [
    callDeepSeek(messages),
    callGeminiDirect(messages),
  ];

  // DeepSeek via OpenRouter (inline to avoid extra function)
  if (apiKey && !isOpenRouterTemporarilyDisabled()) {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    calls.push(
      fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://vedarai.ru',
          'X-Title': 'TourHab Kamchatka',
        },
        body: JSON.stringify({
          model: 'deepseek/deepseek-chat-v3-0324',
          temperature: 0.3,
          max_tokens: 600,
          messages: payload,
        }),
        signal: AbortSignal.timeout(12_000),
      })
        .then(async (res) => {
          if (!res.ok) {
            if (res.status === 401) {
              markOpenRouterAuthFailure();
            }
            return null;
          }
          clearOpenRouterFailure();
          return res.json();
        })
        .then(data => (data?.choices?.[0]?.message?.content as string) ?? null)
        .catch(() => null)
    );
  }

  const result = await raceProviders(calls);
  return result ?? 'Сервис временно недоступен.';
}

// ── Waterfall Direct — алиас основного ────────────────────────
// Claude 4.6 на Timeweb корректно обрабатывает system prompt,
// поэтому отдельный обход больше не нужен.
export async function callAIWaterfallDirect(messages: ChatMessage[]): Promise<string> {
  return callAIWaterfall(messages);
}

/** Like callAIWithModel but returns plain string (for callsites that don't need model_used). */
export async function callAIWithModelDirect(
  messages: ChatMessage[],
  preferredModel?: string | null,
): Promise<string> {
  const { text } = await callAIWithModel(messages, preferredModel);
  return text;
}

// ── Debug Waterfall: диагностика каждого провайдера ──────────
export interface WaterfallDebugResult {
  provider: string;
  model: string;
  status: 'success' | 'no_key' | 'http_error' | 'empty_response' | 'error_in_body' | 'exception';
  http_status?: number;
  error?: string;
  answer_preview?: string;
  latency_ms: number;
}

export async function callAIWaterfallDebug(messages: ChatMessage[]): Promise<WaterfallDebugResult[]> {
  const results: WaterfallDebugResult[] = [];
  const payload = messages.map(({ role, content }) => ({ role, content }));

  // 1. MiMo
  {
    const start = Date.now();
    const apiKey = process.env.XIAOMI_API_KEY;
    if (!apiKey) {
      results.push({ provider: 'mimo', model: 'MiMo-V2-Pro', status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const res = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: 'mimo-v2-pro', temperature: 0.4, max_tokens: 200, messages: payload }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'mimo', model: 'MiMo-V2-Pro', status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          results.push({ provider: 'mimo', model: 'MiMo-V2-Pro', status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'mimo', model: 'MiMo-V2-Pro', status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 2. OpenRouter (each model)
  {
    const apiKey = getOpenRouterKey();
    if (!apiKey) {
      results.push({ provider: 'openrouter', model: 'all', status: 'no_key', latency_ms: 0 });
    } else {
      for (const { id, timeout } of OR_MODELS) {
        const start = Date.now();
        try {
          const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              'HTTP-Referer': 'https://vedarai.ru',
              'X-Title': 'Vedarai Kamchatka',
            },
            body: JSON.stringify({ model: id, temperature: 0.4, max_tokens: 200, messages: payload }),
            signal: AbortSignal.timeout(timeout),
          });
          const ms = Date.now() - start;
          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            results.push({ provider: 'openrouter', model: id, status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
          } else {
            const data = await res.json();
            if (data?.error) {
              results.push({ provider: 'openrouter', model: id, status: 'error_in_body', error: JSON.stringify(data.error).slice(0, 200), latency_ms: ms });
            } else {
              const text = data?.choices?.[0]?.message?.content;
              results.push({ provider: 'openrouter', model: id, status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
            }
          }
        } catch (e) {
          results.push({ provider: 'openrouter', model: id, status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
        }
      }
    }
  }

  // 3. YandexGPT
  {
    const start = Date.now();
    const apiKey = process.env.YANDEX_API_KEY;
    const folderId = process.env.YANDEX_FOLDER_ID;
    if (!apiKey || !folderId) {
      results.push({ provider: 'yandex', model: 'yandexgpt-5.1', status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const yMessages = messages.filter(m => m.role !== 'system').map(({ role, content }) => ({
          role: role === 'assistant' ? 'assistant' : 'user', text: content,
        }));
        const systemMsg = messages.find(m => m.role === 'system');
        if (systemMsg) yMessages.unshift({ role: 'system', text: systemMsg.content });

        const res = await fetch('https://llm.api.cloud.yandex.net/foundationModels/v1/completion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Api-Key ${apiKey}`, 'x-folder-id': folderId },
          body: JSON.stringify({ modelUri: `gpt://${folderId}/yandexgpt-5.1/latest`, completionOptions: { stream: false, temperature: 0.4, maxTokens: '200' }, messages: yMessages }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'yandex', model: 'yandexgpt-5.1', status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.result?.alternatives?.[0]?.message?.text;
          results.push({ provider: 'yandex', model: 'yandexgpt-5.1', status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'yandex', model: 'yandexgpt-5.1', status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 4. DeepSeek direct
  {
    const start = Date.now();
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      results.push({ provider: 'deepseek', model: 'deepseek-chat', status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: 'deepseek-chat', temperature: 0.4, max_tokens: 200, messages: payload }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'deepseek', model: 'deepseek-chat', status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          results.push({ provider: 'deepseek', model: 'deepseek-chat', status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'deepseek', model: 'deepseek-chat', status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 5. Gemini direct
  {
    const start = Date.now();
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      results.push({ provider: 'gemini', model: 'gemini-2.0-flash', status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const systemMsg = messages.find(m => m.role === 'system');
        const turns = messages.filter(m => m.role !== 'system');
        const contents = turns.map(({ role, content }) => ({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text: content }] }));
        const reqBody: Record<string, unknown> = { contents };
        if (systemMsg) reqBody.systemInstruction = { parts: [{ text: systemMsg.content }] };

        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody), signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'gemini', model: 'gemini-2.0-flash', status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          results.push({ provider: 'gemini', model: 'gemini-2.0-flash', status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'gemini', model: 'gemini-2.0-flash', status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 6. xAI
  {
    const start = Date.now();
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      results.push({ provider: 'xai', model: 'grok-4', status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const res = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: 'grok-4', temperature: 0.4, max_tokens: 200, messages: payload }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'xai', model: 'grok-4', status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          results.push({ provider: 'xai', model: 'grok-4', status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'xai', model: 'grok-4', status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 7. Anthropic direct
  {
    const start = Date.now();
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      results.push({ provider: 'anthropic', model: 'claude-haiku-4.5', status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const systemMsg = messages.find(m => m.role === 'system');
        const turns = messages.filter(m => m.role !== 'system');
        const firstUserIdx = turns.findIndex(m => m.role === 'user');
        const clean = firstUserIdx >= 0 ? turns.slice(firstUserIdx) : turns;
        const anthropicMessages = clean.slice(-6).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

        const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL ?? 'claude-fable-5', max_tokens: 200, temperature: 0.4, ...(systemMsg ? { system: systemMsg.content } : {}), messages: anthropicMessages }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'anthropic', model: 'claude-haiku-4.5', status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json() as Record<string, unknown>;
          const content = Array.isArray(data.content) ? data.content as Array<Record<string, unknown>> : [];
          const text = typeof content[0]?.text === 'string' ? content[0].text as string : undefined;
          results.push({ provider: 'anthropic', model: 'claude-haiku-4.5', status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'anthropic', model: 'claude-haiku-4.5', status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 8. Sakana Fugu — primary-провайдер Editor-агента (A/B вариант B).
  // Форма запроса — как в callFugu: FUGU_BASE_URL нормализуется до /v1,
  // модель FUGU_MODEL, лимит через max_completion_tokens (не max_tokens).
  {
    const start = Date.now();
    const apiKey = getFuguKey();
    let base = (process.env.FUGU_BASE_URL || 'https://api.sakana.ai').replace(/\/+$/, '');
    if (!base.endsWith('/v1')) base = `${base}/v1`;
    const model = process.env.FUGU_MODEL || 'fugu';
    if (!apiKey) {
      results.push({ provider: 'fugu', model, status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, max_completion_tokens: 200, messages: payload }),
          signal: AbortSignal.timeout(45_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'fugu', model, status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          results.push({ provider: 'fugu', model, status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'fugu', model, status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 9. GLM (ZhipuAI direct)
  {
    const start = Date.now();
    const apiKey = getGLMKey();
    if (!apiKey) {
      results.push({ provider: 'glm', model: 'glm-5.1', status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: 'glm-5.1', temperature: 0.4, max_tokens: 200, messages: payload }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'glm', model: 'glm-5.1', status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          results.push({ provider: 'glm', model: 'glm-5.1', status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'glm', model: 'glm-5.1', status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 10. NVIDIA NIM
  {
    const start = Date.now();
    const apiKey = getNvidiaKey();
    if (!apiKey) {
      results.push({ provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct', status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: 'meta/llama-3.3-70b-instruct', temperature: 0.4, max_tokens: 200, messages: payload }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct', status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          results.push({ provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct', status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct', status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 11. Groq (OpenAI-compatible, US — geo-проверка)
  {
    const start = Date.now();
    const apiKey = getGroqKey();
    if (!apiKey) {
      results.push({ provider: 'groq', model: GROQ_MODEL, status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: GROQ_MODEL, temperature: 0.4, max_tokens: 200, messages: payload }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'groq', model: GROQ_MODEL, status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          results.push({ provider: 'groq', model: GROQ_MODEL, status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'groq', model: GROQ_MODEL, status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 12. Cerebras (OpenAI-compatible, US — geo-проверка)
  {
    const start = Date.now();
    const apiKey = getCerebrasKey();
    if (!apiKey) {
      results.push({ provider: 'cerebras', model: CEREBRAS_MODEL, status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: CEREBRAS_MODEL, temperature: 0.4, max_tokens: 200, messages: payload }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'cerebras', model: CEREBRAS_MODEL, status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          results.push({ provider: 'cerebras', model: CEREBRAS_MODEL, status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'cerebras', model: CEREBRAS_MODEL, status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 13. Mistral La Plateforme (OpenAI-compatible, EU — geo-проверка)
  {
    const start = Date.now();
    const apiKey = getMistralKey();
    if (!apiKey) {
      results.push({ provider: 'mistral', model: MISTRAL_MODEL, status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: MISTRAL_MODEL, temperature: 0.4, max_tokens: 200, messages: payload }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'mistral', model: MISTRAL_MODEL, status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          results.push({ provider: 'mistral', model: MISTRAL_MODEL, status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'mistral', model: MISTRAL_MODEL, status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  return results;
}
