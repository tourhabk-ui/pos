-- Migration 691: Add direct token/cost columns to ai_actions_log
-- Fixes EvolverAnalysis: column "tokens_out" does not exist
-- observation-logger.ts already writes these values; the columns were missing.

ALTER TABLE ai_actions_log ADD COLUMN IF NOT EXISTS tokens_in INTEGER;
ALTER TABLE ai_actions_log ADD COLUMN IF NOT EXISTS tokens_out INTEGER;
ALTER TABLE ai_actions_log ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10,6);
