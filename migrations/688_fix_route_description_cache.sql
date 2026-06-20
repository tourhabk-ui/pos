-- Migration 688: Fix route_description_cache schema conflict
--
-- Migration 134 created route_description_cache with route_id UUID → agent_route_knowledge(id)
-- Migration 649 tried to create it with route_id INTEGER → operator_tours(id) but was skipped (IF NOT EXISTS)
-- The Editor agent code (route-description-cache.ts) uses INTEGER ids and ::integer cast
-- Result: Editor agent silently fails on every INSERT since UUID ≠ INTEGER
--
-- Fix: rename the broken UUID version, create the correct INTEGER version

-- Step 1: rename old broken table (preserve data just in case)
ALTER TABLE IF EXISTS route_description_cache
  RENAME TO _route_description_cache_legacy;

-- Drop the old broken indexes and FK that reference agent_route_knowledge (now a VIEW)
DROP INDEX IF EXISTS idx_route_description_cache_route_id;
DROP INDEX IF EXISTS idx_route_description_cache_generated_at;

-- Step 2: create the correct table (matches route-description-cache.ts)
CREATE TABLE IF NOT EXISTS route_description_cache (
  route_id      INTEGER     PRIMARY KEY REFERENCES operator_tours(id) ON DELETE CASCADE,
  description   TEXT        NOT NULL,
  model         TEXT        NOT NULL DEFAULT 'editor-agent',
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rdc_generated ON route_description_cache(generated_at DESC);
