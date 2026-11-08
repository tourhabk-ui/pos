/**
 * lib/ai/usage-context.ts
 *
 * Атрибуция LLM-затрат конкретному cron-агенту (Roitman §18.7.4, триада
 * наблюдаемости: latency/duration уже есть в run-logger.ts, токенов и
 * стоимости — не было). При ~40 cron-агентах нельзя было ответить "кто
 * сжёг бюджет вчера" — logLLMUsage в providers.ts не знал вызывающего.
 *
 * AsyncLocalStorage, а не глобальная переменная — агенты могут выполняться
 * параллельно (несколько cron-запусков одновременно), счётчики не должны
 * пересекаться между независимыми вызовами runWithUsageTracking.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

interface UsageAccumulator {
  agentId: string;
  promptTokens: number;
  completionTokens: number;
  llmCalls: number;
  estimatedCostUsd: number;
}

export interface UsageSnapshot {
  prompt_tokens: number;
  completion_tokens: number;
  llm_calls: number;
  estimated_cost_usd: number;
}

const storage = new AsyncLocalStorage<UsageAccumulator>();

/** Имя агента, накапливающего usage в текущем async-контексте, или null вне его. */
export function currentAgentId(): string | null {
  return storage.getStore()?.agentId ?? null;
}

/** Fire-and-forget учёт одного LLM-вызова — no-op вне runWithUsageTracking. */
export function addUsage(promptTokens: number, completionTokens: number, costUsd: number): void {
  const acc = storage.getStore();
  if (!acc) return;
  acc.promptTokens += promptTokens;
  acc.completionTokens += completionTokens;
  acc.llmCalls += 1;
  acc.estimatedCostUsd += costUsd;
}

/**
 * Выполняет fn в контексте атрибуции usage агенту agentId. Все LLM-вызовы
 * внутри fn (включая вложенные await-цепочки) видят currentAgentId() ===
 * agentId и накапливаются в возвращаемый снапшот — независимо от того,
 * сколько промежуточных функций между runWithUsageTracking и вызовом
 * providers.ts.
 */
export async function runWithUsageTracking<T>(
  agentId: string,
  fn: () => Promise<T>,
): Promise<{ result: T; usage: UsageSnapshot }> {
  const acc: UsageAccumulator = {
    agentId, promptTokens: 0, completionTokens: 0, llmCalls: 0, estimatedCostUsd: 0,
  };
  const result = await storage.run(acc, fn);
  return {
    result,
    usage: {
      prompt_tokens: acc.promptTokens,
      completion_tokens: acc.completionTokens,
      llm_calls: acc.llmCalls,
      estimated_cost_usd: acc.estimatedCostUsd,
    },
  };
}

/**
 * То же, что runWithUsageTracking, когда нужен только результат: подпись
 * расхода для крона (08.11). Всё, что внутри зовёт модель, — и вложенный
 * вызов, и фон после ответа — ложится в книги llm_usage_log под agentId.
 * Ближний контекст главнее: явный runWithUsageTracking внутри (эвал с тремя
 * id) подписывает своим id.
 *
 * До 08.11 из 49 кронов, умеющих звать модель, подписывали расход 6; за 30
 * дней 16,6 тыс. вызовов легли в книги строкой «без подписи» (перепись
 * нагрузки Кузьмича, prod-check 166).
 */
export async function withSpendAgent<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  return (await runWithUsageTracking(agentId, fn)).result;
}
