/**
 * lib/agents/sdk/sdk-runner.ts
 *
 * Agentic tool-use loop поверх OpenRouter API.
 * Реализует паттерн Claude Agent SDK: Claude сам выбирает инструменты,
 * вызывает их, получает результаты и продолжает reasoning до финального ответа.
 *
 * Принципиальное отличие от классических агентов:
 *   Классика: intent → switch → SQL → callAI(данные) → ответ  (1 LLM-вызов)
 *   SDK:      message → Claude → [tool?] → execute → Claude → [tool?] → ... → ответ (N вызовов)
 *
 * Инструменты сюда НЕ кладутся: их даёт вызывающий, типизированными наборами по
 * роли — `tourist-tools.ts` и `operator-tools.ts`. Универсальные `makeQueryTool`
 * (произвольный SELECT) и `makeReadMemoryTool` (чтение `agent_memory`) здесь
 * лежали и не были подключены ни к одному набору; удалены 22.08.2026. Причина
 * не в чистоте: произвольный SELECT в чате означает, что подсказка, пришедшая
 * от собеседника, может вычитать `leads.phone` или чужие брони и отправить их
 * в зарубежную модель. Это расширение доступа, а не закрытие пробела. Нужен
 * новый инструмент — заводить его типизированным, в наборе своей роли.
 */

import { getOpenRouterKey } from '@/lib/ai/provider-config';
import { pool } from '@/lib/db-pool';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SDKTool {
  name:        string;
  description: string;
  parameters:  {
    type:       'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?:  string[];
  };
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface SDKRunnerConfig {
  agentId:       string;
  intent:        string;
  systemPrompt:  string;
  userMessage:   string;
  tools:         SDKTool[];
  model?:        string;
  maxIterations?: number;
  experimentId?: string;
}

export interface SDKRunResult {
  response:        string;
  toolCallsCount:  number;
  iterations:      number;
  durationMs:      number;
  inputTokens:     number;
  outputTokens:    number;
}

interface ORMessage {
  role:         'system' | 'user' | 'assistant' | 'tool';
  content:      string | null;
  tool_calls?:  ORToolCall[];
  tool_call_id?: string;
  name?:        string;
}

interface ORToolCall {
  id:       string;
  type:     'function';
  function: { name: string; arguments: string };
}

interface ORResponse {
  choices: Array<{
    message: {
      role:        string;
      content:     string | null;
      tool_calls?: ORToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// ── Core Runner ───────────────────────────────────────────────────────────────

export async function runSDKAgent(config: SDKRunnerConfig): Promise<SDKRunResult> {
  const {
    agentId, intent, systemPrompt, userMessage, tools,
    model = 'anthropic/claude-sonnet-4-6',
    maxIterations = 8,
    experimentId,
  } = config;

  const apiKey = getOpenRouterKey();
  if (!apiKey) throw new Error('OR_API_KEY не настроен');

  const startMs = Date.now();
  const messages: ORMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userMessage },
  ];

  const toolDefs = tools.map(t => ({
    type:     'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const toolMap = new Map(tools.map(t => [t.name, t]));

  let toolCallsCount = 0;
  let iterations     = 0;
  let inputTokens    = 0;
  let outputTokens   = 0;
  const toolCallsLog: Array<{ tool: string; args: unknown; result: string; ms: number }> = [];

  // ── Agentic loop ─────────────────────────────────────────────────────────
  while (iterations < maxIterations) {
    iterations++;

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Authorization':    `Bearer ${apiKey}`,
        'Content-Type':     'application/json',
        'X-Title':          'KamchatourHub Agent SDK',
        'HTTP-Referer':     'https://vedarai.ru',
      },
      body: JSON.stringify({
        model,
        messages,
        tools:       toolDefs.length > 0 ? toolDefs : undefined,
        tool_choice: toolDefs.length > 0 ? 'auto'    : undefined,
        max_tokens:  2048,
        temperature: 0.3,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json() as ORResponse;
    inputTokens  += data.usage?.prompt_tokens     ?? 0;
    outputTokens += data.usage?.completion_tokens ?? 0;

    const choice = data.choices[0];
    if (!choice) throw new Error('OpenRouter: пустой ответ');

    const assistantMsg = choice.message;
    messages.push({
      role:       'assistant',
      content:    assistantMsg.content,
      tool_calls: assistantMsg.tool_calls,
    });

    // ── Финальный ответ ─────────────────────────────────────────────────
    if (choice.finish_reason === 'stop' || !assistantMsg.tool_calls?.length) {
      const response = assistantMsg.content ?? '';
      const durationMs = Date.now() - startMs;

      // Логируем сессию
      await logSession({
        agentId, intent, variant: 'sdk', experimentId,
        toolCallsCount, iterations, inputTokens, outputTokens,
        durationMs, outcome: 'success',
        finalResponse: response.slice(0, 2000),
        toolCallsLog,
      });

      return { response, toolCallsCount, iterations, durationMs, inputTokens, outputTokens };
    }

    // ── Выполняем tool calls ─────────────────────────────────────────────
    for (const call of assistantMsg.tool_calls ?? []) {
      const toolName = call.function.name;
      const tool = toolMap.get(toolName);
      const callStart = Date.now();

      let result: string;
      if (!tool) {
        result = `Инструмент "${toolName}" не найден`;
      } else {
        try {
          const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
          result = await tool.execute(args);
          toolCallsCount++;
          toolCallsLog.push({ tool: toolName, args, result: result.slice(0, 500), ms: Date.now() - callStart });
        } catch (err) {
          result = `Ошибка: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      messages.push({
        role:         'tool',
        tool_call_id: call.id,
        name:         toolName,
        content:      result,
      });
    }
  }

  // Превышен лимит итераций
  const durationMs = Date.now() - startMs;
  await logSession({
    agentId, intent, variant: 'sdk', experimentId,
    toolCallsCount, iterations, inputTokens, outputTokens,
    durationMs, outcome: 'timeout',
    finalResponse: 'max_iterations_reached',
    toolCallsLog,
  });

  return {
    response:       'Агент превысил лимит итераций — возможно, задача слишком сложная.',
    toolCallsCount, iterations, durationMs, inputTokens, outputTokens,
  };
}

// ── Session Logger ─────────────────────────────────────────────────────────────

interface SessionLog {
  agentId:      string;
  intent:       string;
  variant:      'classic' | 'sdk';
  experimentId?: string;
  toolCallsCount: number;
  iterations:   number;
  inputTokens:  number;
  outputTokens: number;
  durationMs:   number;
  outcome:      'success' | 'fail' | 'timeout';
  finalResponse: string;
  toolCallsLog: unknown[];
}

async function logSession(s: SessionLog): Promise<void> {
  pool.query(
    `INSERT INTO agent_sdk_sessions
      (agent_id, intent, variant, experiment_id, tool_calls_count, iterations,
       input_tokens, output_tokens, duration_ms, outcome, final_response, tool_calls_log)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      s.agentId, s.intent, s.variant, s.experimentId ?? null,
      s.toolCallsCount, s.iterations, s.inputTokens, s.outputTokens,
      s.durationMs, s.outcome, s.finalResponse, JSON.stringify(s.toolCallsLog),
    ]
  ).catch(() => { /* non-critical telemetry */ });
}
