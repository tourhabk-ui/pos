/**
 * Проба своей модели на своём железе (владелец 22.10: «проще на своём железе
 * поднять … вместе настроим»). План — docs/OWN_BRAIN_PLAN.md §6.
 *
 * Модель отвечает на вопросы эвала Кузьмича через OpenAI-совместимый адрес
 * (Ollama, LM Studio, llama.cpp server, vLLM), а за фактами ходит в ПУБЛИЧНЫЙ
 * MCP Ведара — те же инструменты, что у агентов снаружи, и только читающие.
 * Живой путь Кузьмича этим не меняется: ни водопад, ни роуты чата не знают
 * про этот модуль, его зовёт только scripts/local-brain-probe.ts.
 *
 * Почему только своё железо (`isOwnHardwareUrl`): проба меряет именно его, а
 * удалённый адрес из env был бы приёмником, мимо реестра D2
 * (lib/agents/compliance/provider-registry.ts). Удалённый провайдер заводится
 * в lib/ai/providers.ts с юрисдикцией, а не переменной окружения.
 *
 * Исходов у ответа три (§4.0): ответ, пусто, отказ запроса — и пусто не
 * выдаётся за ответ. Обрезанный контекст — отдельное предупреждение: Ollama
 * молча срезает начало промпта, если окно меньше, и модель отвечает без
 * системного промпта Кузьмича, а прогон выглядит как «модель слабая».
 */

export interface LocalModelConfig {
  /** База OpenAI-совместимого API, например http://127.0.0.1:11434/v1. */
  baseUrl: string;
  model: string;
  /** Ollama ключа не требует; LM Studio и vLLM — по настройке. */
  apiKey: string | null;
  timeoutMs: number;
  /** Просить модель не размышлять (reasoning_effort: none). */
  noThink: boolean;
}

export const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:11434/v1';

/** Частные сети IPv4: 10/8, 172.16/12, 192.168/16, и loopback. */
function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([m[1], m[2], m[3], m[4]].some((x) => Number(x) > 255)) return false;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * Адрес — своё железо: этот компьютер или машина в домашней сети.
 * `localhost`, `*.local` (mDNS), loopback и частные IPv4, `[::1]`.
 */
export function isOwnHardwareUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true;
  if (host.endsWith('.local')) return true;
  return isPrivateIpv4(host);
}

export type ConfigResult = { ok: true; cfg: LocalModelConfig } | { ok: false; error: string };

export function readLocalModelConfig(env: Record<string, string | undefined>): ConfigResult {
  const baseUrl = (env.LOCAL_LLM_URL || DEFAULT_LOCAL_BASE_URL).trim().replace(/\/+$/, '');
  const model = (env.LOCAL_LLM_MODEL || '').trim();
  if (!model) {
    return { ok: false, error: 'Не задана модель: LOCAL_LLM_MODEL=<имя из `ollama list`>.' };
  }
  if (!isOwnHardwareUrl(baseUrl)) {
    return {
      ok: false,
      error: `Адрес ${baseUrl} — не своё железо. Проба только для этого компьютера или домашней сети;`
        + ' удалённый провайдер заводится в lib/ai/providers.ts и реестре D2.',
    };
  }
  const t = Number(env.LOCAL_LLM_TIMEOUT_MS || 180_000);
  return {
    ok: true,
    cfg: {
      baseUrl,
      model,
      apiKey: env.LOCAL_LLM_KEY?.trim() || null,
      timeoutMs: Number.isFinite(t) && t > 0 ? t : 180_000,
      noThink: env.LOCAL_LLM_THINK !== '1',
    },
  };
}

// ── Инструменты ─────────────────────────────────────────────────────────────

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/**
 * Только читающие инструменты публичного MCP (`readOnlyHint: true`). Заявки
 * и правки планов в пробе не предлагаются: проба не должна оставлять в
 * базе ни лида, ни строки, которую потом примут за туриста.
 * Нет пометки — не предлагается: неизвестное не считается безопасным.
 */
export function readOnlyToolsForProbe(list: McpToolInfo[]): OpenAiTool[] {
  return list
    .filter((t) => t.annotations?.readOnlyHint === true)
    .map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: (t.description ?? '').slice(0, 1200),
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
      },
    }));
}

// ── Один вопрос ─────────────────────────────────────────────────────────────

export type ThinkParam = 'sent-none' | 'not-supported' | 'not-sent';

export interface TurnResult {
  /** Текст ответа без блоков размышления; null — ответа нет. */
  answer: string | null;
  ms: number;
  rounds: number;
  toolCalls: string[];
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Длина размышления (поле reasoning или блок <think>), в символах. */
  reasoningChars: number;
  thinkParam: ThinkParam;
  /** Отказ запроса: сеть, HTTP, разбор, лимит раундов. null — запрос прошёл. */
  error: string | null;
  /** Пусто из-за упора в длину — отдельный провал, не «модель промолчала». */
  lengthCut: boolean;
  contextWarning: string | null;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

const THINK_BLOCK = /<think>[\s\S]*?(<\/think>|$)/gi;
const TOOL_TEXT_MAX = 8000;

/**
 * Окно модели меньше промпта — Ollama срежет начало молча. Признак: модель
 * насчитала токенов заметно меньше, чем могло быть в тексте (русский текст —
 * не больше ~5 символов на токен), или ровно круглое число окна.
 */
export function contextLooksTruncated(promptChars: number, promptTokens: number | null): string | null {
  if (promptTokens == null) return 'модель не вернула usage — обрезку контекста проверить нечем';
  if ([2048, 4096, 8192].includes(promptTokens)) {
    return `промпт ровно ${promptTokens} токенов — похоже на упор в окно; поднимите OLLAMA_CONTEXT_LENGTH`;
  }
  if (promptTokens < promptChars / 6) {
    return `промпт ${promptChars} символов, а модель насчитала ${promptTokens} токенов — вероятно, окно срезало начало`;
  }
  return null;
}

function readReasoning(msg: Record<string, unknown>): number {
  const r = msg.reasoning ?? msg.reasoning_content;
  return typeof r === 'string' ? r.length : 0;
}

export interface ProbeTurnInput {
  cfg: LocalModelConfig;
  system: string;
  question: string;
  tools: OpenAiTool[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxRounds?: number;
}

export async function runProbeTurn(input: ProbeTurnInput): Promise<TurnResult> {
  const { cfg, system, question, tools, callTool } = input;
  const doFetch = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const maxRounds = input.maxRounds ?? 5;
  const toolNames = new Set(tools.map((t) => t.function.name));
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: question },
  ];
  const promptChars = system.length + question.length + JSON.stringify(tools).length;

  const res: TurnResult = {
    answer: null, ms: 0, rounds: 0, toolCalls: [], finishReason: null,
    promptTokens: null, completionTokens: null, reasoningChars: 0,
    thinkParam: cfg.noThink ? 'sent-none' : 'not-sent',
    error: null, lengthCut: false, contextWarning: null,
  };
  const started = now();

  const post = async (): Promise<Response> => {
    const body: Record<string, unknown> = { model: cfg.model, messages, stream: false };
    if (tools.length) body.tools = tools;
    if (res.thinkParam === 'sent-none') body.reasoning_effort = 'none';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    return doFetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  };

  try {
    for (let round = 0; round < maxRounds; round += 1) {
      res.rounds = round + 1;
      let r = await post();
      // Модель без переключателя размышлений отвергает параметр — тогда
      // повтор без него, и отчёт называет это, а не прячет.
      if (!r.ok && r.status === 400 && res.thinkParam === 'sent-none') {
        const text = await r.text();
        if (/reason|think/i.test(text)) {
          res.thinkParam = 'not-supported';
          r = await post();
        } else {
          res.error = `HTTP 400: ${text.slice(0, 200)}`;
          break;
        }
      }
      if (!r.ok) {
        res.error = `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`;
        break;
      }
      const j = await r.json() as {
        choices?: Array<{ finish_reason?: string | null; message?: Record<string, unknown> }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = j.choices?.[0];
      const msg = choice?.message;
      if (!msg) { res.error = 'в ответе нет choices[0].message'; break; }
      res.finishReason = choice?.finish_reason ?? null;
      if (typeof j.usage?.prompt_tokens === 'number') {
        res.promptTokens = Math.max(res.promptTokens ?? 0, j.usage.prompt_tokens);
      }
      if (typeof j.usage?.completion_tokens === 'number') {
        res.completionTokens = (res.completionTokens ?? 0) + j.usage.completion_tokens;
      }
      const rawContent = typeof msg.content === 'string' ? msg.content : '';
      const thinkInContent = (rawContent.match(THINK_BLOCK) ?? []).join('').length;
      res.reasoningChars += readReasoning(msg) + thinkInContent;
      const content = rawContent.replace(THINK_BLOCK, '').trim();

      const calls = Array.isArray(msg.tool_calls)
        ? (msg.tool_calls as Array<{ id?: string; function?: { name?: string; arguments?: string } }>)
        : [];
      if (calls.length === 0) {
        res.answer = content || null;
        res.lengthCut = !content && res.finishReason === 'length';
        break;
      }
      if (round === maxRounds - 1) {
        res.error = `модель просила инструменты ${maxRounds} раундов подряд и не ответила`;
        break;
      }
      const normalized = calls.map((c, i) => ({
        id: c.id || `call_${round}_${i}`,
        type: 'function' as const,
        function: { name: c.function?.name ?? '', arguments: c.function?.arguments ?? '{}' },
      }));
      messages.push({ role: 'assistant', content: content || null, tool_calls: normalized });
      for (const c of normalized) {
        res.toolCalls.push(c.function.name);
        let out: string;
        if (!toolNames.has(c.function.name)) {
          out = `Инструмента ${c.function.name} в пробе нет. Доступны: ${[...toolNames].join(', ')}.`;
        } else {
          let args: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = JSON.parse(c.function.arguments || '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
          } catch { args = null; }
          if (!args) {
            out = `Аргументы не разобраны как JSON-объект: ${c.function.arguments.slice(0, 200)}`;
          } else {
            out = await callTool(c.function.name, args).catch((e: unknown) => `Инструмент не ответил: ${String(e).slice(0, 200)}`);
          }
        }
        messages.push({ role: 'tool', tool_call_id: c.id, content: out.slice(0, TOOL_TEXT_MAX) });
      }
    }
  } catch (e: unknown) {
    res.error = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : String(e).slice(0, 200);
  }
  res.ms = now() - started;
  res.contextWarning = res.error ? null : contextLooksTruncated(promptChars, res.promptTokens);
  return res;
}

// ── Сводка ─────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

export interface ProbeSummary {
  total: number;
  answered: number;
  empty: number;
  errors: number;
  lengthCut: number;
  contextWarnings: number;
  /** p50/p95 только по ответившим; null — мерить не на чем. */
  p50Ms: number | null;
  p95Ms: number | null;
  /** Токенов в секунду по ответившим (выход / время); null — usage не пришёл. */
  tokensPerSec: number | null;
  turnsWithTools: number;
  thinkNotSupported: boolean;
}

export function summarizeProbe(results: TurnResult[]): ProbeSummary {
  const answered = results.filter((r) => r.answer != null && !r.error);
  const ms = answered.map((r) => r.ms).sort((a, b) => a - b);
  const withUsage = answered.filter((r) => r.completionTokens != null && r.ms > 0);
  const tok = withUsage.reduce((s, r) => s + (r.completionTokens ?? 0), 0);
  const sec = withUsage.reduce((s, r) => s + r.ms, 0) / 1000;
  return {
    total: results.length,
    answered: answered.length,
    empty: results.filter((r) => r.answer == null && !r.error).length,
    errors: results.filter((r) => r.error).length,
    lengthCut: results.filter((r) => r.lengthCut).length,
    contextWarnings: results.filter((r) => r.contextWarning).length,
    p50Ms: percentile(ms, 50),
    p95Ms: percentile(ms, 95),
    tokensPerSec: withUsage.length && sec > 0 ? Math.round((tok / sec) * 10) / 10 : null,
    turnsWithTools: results.filter((r) => r.toolCalls.length > 0).length,
    thinkNotSupported: results.some((r) => r.thinkParam === 'not-supported'),
  };
}

// ── Публичный MCP ───────────────────────────────────────────────────────────

/** Имя клиента пробы — в реестре проверок (lib/mcp/probe-clients.ts). */
export const LOCAL_PROBE_CLIENT = 'vedar-local-brain-probe';

/** Тело ответа MCP: JSON или поток SSE, из которого берётся последнее `data:`. */
export function parseMcpBody(text: string): unknown {
  let t = text;
  if (t.includes('data:')) {
    const data = t.split('\n').filter((l) => l.startsWith('data:')).pop();
    if (data) t = data.slice(5);
  }
  return JSON.parse(t);
}

export function createMcpClient(base: string, fetchImpl: typeof fetch = fetch) {
  let sid: string | null = null;
  let id = 0;
  const url = `${base.replace(/\/+$/, '')}/api/mcp`;
  async function rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
      'user-agent': `${LOCAL_PROBE_CLIENT}/1.0`,
    };
    if (sid) h['Mcp-Session-Id'] = sid;
    id += 1;
    const r = await fetchImpl(url, {
      method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(60_000),
    });
    sid = r.headers.get('mcp-session-id') ?? sid;
    if (!r.ok) throw new Error(`MCP ${method}: HTTP ${r.status}`);
    const j = parseMcpBody(await r.text());
    if (!j || typeof j !== 'object') throw new Error(`MCP ${method}: ответ не объект`);
    const err = (j as { error?: { message?: string } }).error;
    if (err) throw new Error(`MCP ${method}: ${err.message ?? 'ошибка'}`);
    return j as Record<string, unknown>;
  }
  return {
    async initialize(): Promise<string | null> {
      const j = await rpc('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vedar-local-brain-probe', version: '1' },
      });
      const instr = (j.result as { instructions?: unknown } | undefined)?.instructions;
      return typeof instr === 'string' ? instr : null;
    },
    async listTools(): Promise<McpToolInfo[]> {
      const j = await rpc('tools/list', {});
      const tools = (j.result as { tools?: unknown } | undefined)?.tools;
      return Array.isArray(tools) ? (tools as McpToolInfo[]) : [];
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
      const j = await rpc('tools/call', { name, arguments: args });
      const content = (j.result as { content?: Array<{ text?: string }> } | undefined)?.content ?? [];
      return content.map((c) => c.text ?? '').join('');
    },
  };
}
