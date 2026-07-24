/**
 * Agent-to-Model mapping — each agent gets a unique AI model.
 * All models are called via OpenRouter (single API key, single billing).
 *
 * To change an agent's model, edit the map below. No other files need changing.
 */

export type AgentId =
  | 'admin' | 'legal' | 'security' | 'hacker' | 'rescue'
  | 'eco' | 'content' | 'quality' | 'planning' | 'evo'
  | 'finance' | 'infra' | 'vibe_coder'
  | 'kuzmich' | 'planner' | 'operator' | 'router';

/**
 * Map of agent ID to OpenRouter model ID.
 * Every model here is callable via https://openrouter.ai/api/v1/chat/completions.
 */
export const AGENT_MODEL_MAP: Record<AgentId, string> = {
  // Board Directors — быстрые и проверенные модели (апрель 2026)
  admin:      'google/gemini-2.0-flash-001',              // лидер: быстрый, надёжный
  legal:      'openai/gpt-4o-mini',                       // compliance, структурированный
  security:   'mistralai/mistral-small-3.2-24b-instruct', // безопасность: сильный
  hacker:     'deepseek/deepseek-chat-v3-0324',           // рост: аналитика, дешёвый
  rescue:     'meta-llama/llama-3.3-70b-instruct',        // SAR: быстрый, проверенный
  eco:        'google/gemini-2.5-flash-lite',             // эко: 1M context, дешёвый
  content:    'google/gemini-2.0-flash-001',              // аудит: быстрый
  quality:    'openai/gpt-4o-mini',                       // качество: надёжный
  planning:   'anthropic/claude-fable-5',                 // стратегия: flagship качество
  evo:        'anthropic/claude-opus-5',                  // архитектор: premium reasoning
  finance:    'deepseek/deepseek-chat-v3-0324',           // CFO: аналитика, дешёвый
  infra:      'google/gemini-2.0-flash-001',              // SRE: быстрый
  vibe_coder: 'anthropic/claude-fable-5',                 // кодер: flagship качество кода
  // Site-wide agents — Fable 5 (flagship)
  kuzmich:    'anthropic/claude-fable-5',   // Telegram persona
  planner:    'anthropic/claude-fable-5',   // trip planning
  operator:   'anthropic/claude-fable-5',   // operator chat
  router:     'anthropic/claude-fable-5',   // route recommendations
};

/** Default model for consensus (Round 3 facilitator) */
export const CONSENSUS_MODEL = 'anthropic/claude-fable-5';

/**
 * Get the preferred OpenRouter model for an agent.
 * Returns null if agent ID is unknown (fallback to waterfall).
 *
 * Здесь была CRON_MODEL_MAP — «дешёвые модели для cron-задач» на 13 записей.
 * Сверка 24.07: `getModelForAgent(..., true)` не вызывался НИ РАЗУ во всём репо,
 * то есть карта не влияла ни на один прогон, а её комментарий утверждал
 * обратное («Used by cron jobs, scheduled reports»). Мёртвая конфигурация,
 * описывающая несуществующее поведение, удалена.
 *
 * Если удешевление cron-прогонов понадобится — это отдельное осознанное
 * изменение: нужно И вернуть карту, И реально прокинуть признак cron в места
 * вызова (сейчас таких мест нет).
 */
export function getModelForAgent(agentId: string): string | null {
  return (AGENT_MODEL_MAP as Record<string, string>)[agentId] ?? null;
}

/**
 * Get a human-readable short name from model ID.
 * E.g., 'anthropic/claude-sonnet-4-6' -> 'claude-sonnet-4-6'
 */
export function getModelDisplayName(modelId: string): string {
  const parts = modelId.split('/');
  return parts.length > 1 ? parts[1] : modelId;
}
