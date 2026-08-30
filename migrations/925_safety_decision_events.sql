-- 925: Safety Decision Ledger — append-only журнал жизненного цикла
-- safety-алертов конвейера external_alerts (сейсмика, МЧС, FIRMS).
--
-- Контекст: инцидент #883 показал, что "inserted: 0" может значить четыре
-- разных факта об одном ПРОГОНЕ ингеста — ingest-outcome.ts это решил, но
-- только для прогона целиком. У ОТДЕЛЬНОГО алерта своей истории по-прежнему
-- нет: кто/что заметил, как классифицировал, опубликовал ли, разослал ли —
-- всё это происходит и исчезает бесследно. Эта таблица — история одного
-- алерта, не одного прогона.
--
-- Паттерн скопирован с agent_events (917_agent_kernel.sql) — append-only
-- через BEFORE UPDATE OR DELETE ... RAISE EXCEPTION. Отличия осознанные:
--   - нет seq/атомарного счётчика: agent_events нужен gapless-номер внутри
--     ОДНОЙ задачи для kernel replay, здесь сущности разные и порядок даёт
--     id BIGSERIAL/created_at — счётчик с блокировкой строки не нужен;
--   - entity_id TEXT без FK: entity_type подразумевает несколько типов
--     сущности в будущем (алерт, маршрут, тур) — жёсткий FK на
--     external_alerts.id запер бы схему под один тип. Та же цена уже
--     принята у external_alerts.alert_type (VARCHAR без CHECK);
--   - event_type без CHECK: тот же прецедент, что agent_events.event_type —
--     закрытый список держит TS union (SafetyLedgerEventType,
--     lib/safety/ledger.ts), потому что запись идёт ТОЛЬКО через одну
--     функцию (appendSafetyEvent), не произвольным SQL.
--
-- payload_hash — sha256 сырого item источника — коррелирует события ДО
-- появления строки в external_alerts (source_observed, signal_normalized,
-- risk_classified у только что увиденного, ещё не вставленного элемента).

CREATE TABLE IF NOT EXISTS safety_decision_events (
  id                    BIGSERIAL PRIMARY KEY,
  entity_type           VARCHAR(20) NOT NULL DEFAULT 'external_alert',
  entity_id             TEXT,
  event_type            VARCHAR(40) NOT NULL,
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_type            VARCHAR(20) NOT NULL,
  actor_id              VARCHAR(200),
  source_url            TEXT,
  source_published_at   TIMESTAMPTZ,
  payload_hash          VARCHAR(64),
  prior_event_id        BIGINT REFERENCES safety_decision_events(id),
  decision_reason       TEXT,
  details               JSONB NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_safety_decision_events_entity
  ON safety_decision_events(entity_type, entity_id, id);

CREATE INDEX IF NOT EXISTS idx_safety_decision_events_hash
  ON safety_decision_events(payload_hash)
  WHERE payload_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_safety_decision_events_type_time
  ON safety_decision_events(event_type, created_at DESC);

CREATE OR REPLACE FUNCTION safety_decision_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'safety_decision_events append-only: % запрещён', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_safety_decision_events_append_only ON safety_decision_events;
CREATE TRIGGER trg_safety_decision_events_append_only
  BEFORE UPDATE OR DELETE ON safety_decision_events
  FOR EACH ROW EXECUTE FUNCTION safety_decision_events_append_only();

COMMENT ON TABLE safety_decision_events IS
  'Safety Decision Ledger: append-only история жизненного цикла одного safety-алерта (source_observed..traveller_notified). Фаза 1 — только external_alerts, см. lib/safety/ledger.ts';
COMMENT ON COLUMN safety_decision_events.payload_hash IS
  'sha256 сырого item источника — коррелирует события ДО появления строки в entity-таблице';
COMMENT ON COLUMN safety_decision_events.entity_id IS
  'NULL до первой вставки в entity-таблицу (source_observed, fetch_failed, signal_normalized до saveEvent)';
