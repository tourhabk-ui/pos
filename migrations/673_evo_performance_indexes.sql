-- Migration 673: индексы производительности по результатам Growth Agent scan
-- Created: 2026-06-08

-- operator_bookings.created_at и booking_status — горячие колонки без индексов
-- agent_memory.created_at — ORDER BY created_at DESC в intelligence-feed
-- Все индексы CONCURRENTLY — не блокируют запись во время создания
--
-- Правка 28.07: миграция не применялась ни разу. Причину дал аудит боевой
-- схемы — в `ai_actions_log` НЕТ колонки `agent_id` (там id, action_type,
-- metadata, created_at, provider, user_id, tokens_in, tokens_out, cost_usd).
-- Индекс по несуществующей колонке ронял весь файл, а с ним и три исправных
-- индекса. Строка про ai_actions_log убрана: заводить индекс раньше самой
-- колонки нечестно, а объявление колонки — отдельная работа (она числится в
-- KNOWN_GAPS вместе с agent_name, details, result, status — код пишет в
-- ai_actions_log поля, которых схема не объявляла).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_operator_bookings_created_at
  ON operator_bookings(created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_operator_bookings_booking_status
  ON operator_bookings(booking_status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_memory_created_at
  ON agent_memory(created_at DESC);

-- Rollback:
-- DROP INDEX CONCURRENTLY IF EXISTS idx_operator_bookings_created_at;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_operator_bookings_booking_status;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_agent_memory_created_at;
