-- 1308: индекс журнала прогонов по времени окончания (аудит 15.10, 1.15, P3-17).
--
-- Watchdog берёт последние прогоны каждого крона окном
-- ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY ended_at DESC) с отбором
-- agent_id = ANY(...) (lib/agents/watchdog.ts, fetchPerAgentHistory), а оба
-- индекса таблицы (143) — по created_at. Журнал не чистится, и каждый прогон
-- сторожа сортирует всю историю крона.
--
-- CONCURRENTLY: раннер применяет такие файлы вне транзакции, по выражению,
-- без блокировки записи в журнал. Идемпотентно (IF NOT EXISTS).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_run_history_agent_ended
  ON agent_run_history (agent_id, ended_at DESC);
