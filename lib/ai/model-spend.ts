/**
 * lib/ai/model-spend.ts — расход по КАЖДОЙ модели из нашего `llm_usage_log`.
 *
 * Провайдер отдаёт (если отдаёт) остаток на счёт, а не по моделям. Разрез по
 * моделям есть только у нас: `logLLMUsage` в providers.ts пишет каждую
 * ответившую модель строкой (`route` = id модели, токены, оценка цены).
 *
 * Цена — оценка (`estimated_cost_usd`), и она бывает NULL: модель вне
 * каталога цен (#1862, миграция 961). SUM(...) NULL пропускает молча, поэтому
 * рядом с суммой всегда идёт число строк с неизвестной ценой — «дёшево» и
 * «не посчитано» обязаны различаться.
 */

import { pool } from '@/lib/db-pool';

export interface ModelSpendWindow {
  calls: number;
  tokens: number;
  /** Сумма известных цен, USD; null — ни одной строки с ценой. */
  cost_usd: number | null;
  /** Строки, у которых цена неизвестна — они в cost_usd НЕ вошли. */
  unknown_cost_calls: number;
}

export interface ModelSpend {
  model: string;
  /** Догадка о провайдере по имени модели — только для группировки на экране. */
  provider_guess: string;
  d1: ModelSpendWindow;
  d7: ModelSpendWindow;
  d30: ModelSpendWindow;
}

/**
 * Провайдер по имени модели. Это ДОГАДКА для группировки, не факт из лога:
 * в `llm_usage_log` провайдера нет. Нераспознанное имя — 'unknown', не
 * «ближайший похожий».
 */
export function guessProvider(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('/')) return 'openrouter';
  if (m.startsWith('deepseek')) return 'deepseek';
  if (m.startsWith('qwen') || m.startsWith('qwq')) return 'qwen';
  if (m.startsWith('grok')) return 'xai';
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('gemini')) return 'gemini';
  if (m.startsWith('kimi') || m.startsWith('moonshot')) return 'kimi';
  if (m.startsWith('yandexgpt') || m.startsWith('gpt://')) return 'yandex';
  if (m.startsWith('glm')) return 'glm';
  if (m.startsWith('mimo')) return 'mimo';
  if (m.startsWith('minimax') || m.startsWith('abab')) return 'minimax';
  if (m.startsWith('mistral') || m.startsWith('open-mistral') || m.startsWith('codestral')) return 'mistral';
  if (m.startsWith('fugu')) return 'fugu';
  return 'unknown';
}

interface SpendRow {
  model: string;
  calls_1: number; tokens_1: number | null; cost_1: string | null; unknown_1: number;
  calls_7: number; tokens_7: number | null; cost_7: string | null; unknown_7: number;
  calls_30: number; tokens_30: number | null; cost_30: string | null; unknown_30: number;
}

function toWindow(calls: number, tokens: number | null, cost: string | null, unknown: number): ModelSpendWindow {
  const parsed = cost === null ? null : Number(cost);
  return {
    calls,
    tokens: tokens ?? 0,
    cost_usd: parsed !== null && Number.isFinite(parsed) ? parsed : null,
    unknown_cost_calls: unknown,
  };
}

/** Расход по моделям за 1 / 7 / 30 дней. Только чтение. */
export async function loadModelSpend(): Promise<ModelSpend[]> {
  const { rows } = await pool.query<SpendRow>(`
    SELECT
      route AS model,
      COUNT(*)            FILTER (WHERE created_at > NOW() - INTERVAL '1 day')::int  AS calls_1,
      SUM(total_tokens)   FILTER (WHERE created_at > NOW() - INTERVAL '1 day')::int  AS tokens_1,
      SUM(estimated_cost_usd) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')   AS cost_1,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day' AND estimated_cost_usd IS NULL)::int AS unknown_1,
      COUNT(*)            FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS calls_7,
      SUM(total_tokens)   FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS tokens_7,
      SUM(estimated_cost_usd) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')  AS cost_7,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days' AND estimated_cost_usd IS NULL)::int AS unknown_7,
      COUNT(*)::int                                                                  AS calls_30,
      SUM(total_tokens)::int                                                         AS tokens_30,
      SUM(estimated_cost_usd)                                                        AS cost_30,
      COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::int                        AS unknown_30
    FROM llm_usage_log
    WHERE created_at > NOW() - INTERVAL '30 days'
    GROUP BY route
    ORDER BY SUM(estimated_cost_usd) DESC NULLS LAST, SUM(total_tokens) DESC
  `);
  return rows.map((r) => ({
    model: r.model,
    provider_guess: guessProvider(r.model),
    d1:  toWindow(r.calls_1,  r.tokens_1,  r.cost_1,  r.unknown_1),
    d7:  toWindow(r.calls_7,  r.tokens_7,  r.cost_7,  r.unknown_7),
    d30: toWindow(r.calls_30, r.tokens_30, r.cost_30, r.unknown_30),
  }));
}
