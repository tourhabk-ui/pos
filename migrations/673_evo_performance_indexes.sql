-- Migration 673: индексы производительности по результатам Growth Agent scan
-- Created: 2026-06-08

-- operator_bookings.created_at и booking_status — горячие колонки без индексов
-- agent_memory.created_at — ORDER BY created_at DESC в intelligence-feed
-- ai_actions_log.agent_id — GROUP BY agent_id в evolver-analysis
-- Все индексы CONCURRENTLY — не блокируют запись во время создания

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_operator_bookings_created_at
  ON operator_bookings(created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_operator_bookings_booking_status
  ON operator_bookings(booking_status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_memory_created_at
  ON agent_memory(created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ai_actions_log_agent_id
  ON ai_actions_log(agent_id);

-- Rollback:
-- DROP INDEX CONCURRENTLY IF EXISTS idx_operator_bookings_created_at;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_operator_bookings_booking_status;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_agent_memory_created_at;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_ai_actions_log_agent_id;
