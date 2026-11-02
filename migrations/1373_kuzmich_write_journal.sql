-- 1373: журнал пишущих шагов Кузьмича (аудит agents-arch, разрыв №4).
--
-- Каждая попытка создать заявку из веб-чата / MAX / Telegram (тур, лид,
-- поездка с частями) пишет ДВЕ строки: phase='started' до вызова исполнителя
-- и phase='finished' после — прерванный шаг виден как started без finished.
-- Личных данных нет: только id сессии/чата, инструмент, номер заявки,
-- исход и короткая причина. idempotency_key — sha256 от канала, сессии,
-- инструмента и аргументов за сутки: повтор шага не создаёт вторую заявку.
-- Таблица append-only: UPDATE/DELETE режет триггер (как agent_events, 917).

CREATE TABLE IF NOT EXISTS kuzmich_write_journal (
  id               BIGSERIAL PRIMARY KEY,
  idempotency_key  VARCHAR(64) NOT NULL,
  phase            VARCHAR(10) NOT NULL CHECK (phase IN ('started','finished')),
  channel          VARCHAR(20) NOT NULL,
  session_ref      VARCHAR(120) NOT NULL,
  tool             VARCHAR(60) NOT NULL,
  request_ref      VARCHAR(60),
  outcome          VARCHAR(20) CHECK (outcome IN ('created','refused','unknown')),
  reason           VARCHAR(200),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kuzmich_write_journal_key ON kuzmich_write_journal(idempotency_key, id DESC);
CREATE INDEX IF NOT EXISTS idx_kuzmich_write_journal_created ON kuzmich_write_journal(created_at DESC);

CREATE OR REPLACE FUNCTION kuzmich_write_journal_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'kuzmich_write_journal append-only: % запрещён', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kuzmich_write_journal_append_only ON kuzmich_write_journal;
CREATE TRIGGER trg_kuzmich_write_journal_append_only
  BEFORE UPDATE OR DELETE ON kuzmich_write_journal
  FOR EACH ROW EXECUTE FUNCTION kuzmich_write_journal_append_only();

COMMENT ON TABLE kuzmich_write_journal IS 'Пишущие шаги Кузьмича: started/finished на попытку, без ПД, идемпотентность по ключу';
