-- Migration 686: LLM usage tracking
-- Logs prompt/completion token counts and estimated cost per AI call.
-- Idempotent: safe to re-run.
CREATE TABLE IF NOT EXISTS llm_usage_log (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  route               TEXT NOT NULL,
  prompt_tokens       INT NOT NULL DEFAULT 0,
  completion_tokens   INT NOT NULL DEFAULT 0,
  total_tokens        INT NOT NULL DEFAULT 0,
  estimated_cost_usd  NUMERIC(10,6) NOT NULL DEFAULT 0,
  user_id             UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS llm_usage_log_created_idx ON llm_usage_log(created_at);
CREATE INDEX IF NOT EXISTS llm_usage_log_route_idx   ON llm_usage_log(route);
