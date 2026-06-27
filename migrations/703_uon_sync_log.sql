-- 703_uon_sync_log.sql
-- Лог синхронизаций с U-ON.Travel CRM: латентность, статус, ошибки.
-- Источник для health-метрики /api/health/uon-sync (#198) и диагностики (#199).

CREATE TABLE IF NOT EXISTS uon_sync_log (
  id             UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  operator_id    UUID,
  booking_id     TEXT,
  endpoint       TEXT        NOT NULL,
  success        BOOLEAN     NOT NULL,
  http_status    INTEGER,
  latency_ms     INTEGER     NOT NULL DEFAULT 0,
  uon_request_id INTEGER,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS uon_sync_log_created_idx ON uon_sync_log (created_at);
CREATE INDEX IF NOT EXISTS uon_sync_log_operator_idx ON uon_sync_log (operator_id)
  WHERE operator_id IS NOT NULL;
