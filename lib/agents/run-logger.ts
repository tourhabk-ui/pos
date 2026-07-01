/**
 * lib/agents/run-logger.ts
 *
 * Logs each agent cron run to agent_run_history.
 * Fire-and-forget — never throws, never blocks the main flow.
 */

import { pool } from '@/lib/db-pool';

export interface RunLogParams {
  agent_id: string;
  status: 'success' | 'partial' | 'failed';
  started_at: Date;
  duration_ms: number;
  items_processed?: number;
  items_created?: number;
  errors_count?: number;
  error_msg?: string;
  metadata?: Record<string, unknown>;
  // Roitman §18.7.4 — usage per run (см. lib/ai/usage-context.ts runWithUsageTracking)
  prompt_tokens?: number;
  completion_tokens?: number;
  llm_calls?: number;
  estimated_cost_usd?: number;
}

export async function logAgentRun(params: RunLogParams): Promise<void> {
  const ended_at = new Date(params.started_at.getTime() + params.duration_ms);
  try {
    await pool.query(
      `INSERT INTO agent_run_history
         (agent_id, status, started_at, ended_at, duration_ms,
          items_processed, items_created, errors_count, error_msg, metadata,
          prompt_tokens, completion_tokens, llm_calls, estimated_cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        params.agent_id,
        params.status,
        params.started_at,
        ended_at,
        params.duration_ms,
        params.items_processed ?? null,
        params.items_created ?? null,
        params.errors_count ?? 0,
        params.error_msg ?? null,
        params.metadata ? JSON.stringify(params.metadata) : null,
        params.prompt_tokens ?? null,
        params.completion_tokens ?? null,
        params.llm_calls ?? null,
        params.estimated_cost_usd ?? null,
      ]
    );
  } catch (err) {
    console.error('[run-logger] Failed to log run for', params.agent_id, err instanceof Error ? err.message : err);
  }
}
