-- 1451: журнал уборки по сроку хранения (#3388, п. 2, шаг 2).
--
-- Политика обещает хранить технические логи 90 дней; исполняет это уборка
-- lib/legal/retention-purge.ts (удаляет или обезличивает строки старше срока).
-- Каждое её действие с apply пишется сюда: какая таблица, удаление или
-- обезличивание, сколько строк, исход. Имён, текстов и id убранных строк
-- здесь нет — только счёт. Сухой прогон сюда не пишет.
--
-- Идемпотентна: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS retention_purge_log (
  id            BIGSERIAL PRIMARY KEY,
  ran_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  table_name    TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('delete', 'anonymize')),
  rows_affected INTEGER NOT NULL CHECK (rows_affected >= 0),
  state         TEXT NOT NULL CHECK (state IN ('ok', 'failed')),
  sqlstate      TEXT
);

CREATE INDEX IF NOT EXISTS idx_retention_purge_log_ran_at ON retention_purge_log (ran_at DESC);
