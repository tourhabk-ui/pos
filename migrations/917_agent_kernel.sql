-- 917: Agent Kernel v1 — каноническое состояние задач агентов и журнал переходов.
--
-- До этого дня у платформы не было единого места, где задача агента имеет
-- identity и восстановимую историю: ContextHub живёт время запроса,
-- agent_run_history — агрегат итогов (и остаётся им — дашборд читает его,
-- kernel его не заменяет), а policy/effects были размазаны по endpoint'ам.
--
-- agent_tasks  — одна строка на задачу: кто (principal), что (capability),
--                над чем (resource), риск, состояние, lease исполнителя,
--                ключ идемпотентности + input_hash (повтор с тем же ключом,
--                но другим входом — конфликт, а не старый результат).
-- agent_events — append-only журнал переходов и эффектов, (task_id, seq)
--                уникален. Не обновляется и не удаляется НИКОГДА — держит
--                это не только сторож, но и триггер БД ниже.
--
-- Состояния v1 (решение владельца 27.08): partial — НЕ состояние задачи, а
-- исход прогона/стадии (живёт в details события и в summary); иначе по
-- задаче не понять, можно ли продолжать или повторять. Отдельная таблица
-- agent_effects отложена: v1 не обещает exactly-once для внешних API —
-- связка событий effect_started/effect_committed даёт наблюдаемость, окно
-- сбоя между внешним commit и записью события остаётся и названо вслух.

CREATE TABLE IF NOT EXISTS agent_tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_task_id   UUID REFERENCES agent_tasks(id),
  trace_id         UUID NOT NULL,
  principal        VARCHAR(200) NOT NULL,   -- operator:<id> / admin:<id> / cron:evo / system
  capability       VARCHAR(100) NOT NULL,   -- tour.set_published / initiative.<action_type> / evo.run
  resource_type    VARCHAR(100),
  resource_id      VARCHAR(200),
  risk             VARCHAR(20) NOT NULL CHECK (risk IN ('safe','review','forbidden')),
  state            VARCHAR(30) NOT NULL CHECK (state IN (
                     'proposed','awaiting_approval','queued','running',
                     'succeeded','failed_retryable','failed_terminal',
                     'cancelled','rejected')),
  idempotency_key  VARCHAR(300),
  policy_version   VARCHAR(50),
  input_hash       VARCHAR(64),
  claimed_by       VARCHAR(200),
  lease_until      TIMESTAMPTZ,
  attempt          INTEGER NOT NULL DEFAULT 0,
  last_seq         INTEGER NOT NULL DEFAULT 0,  -- атомарный счётчик seq событий задачи
  approval_id      UUID,                        -- связь с agent_approvals при awaiting_approval
  summary          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Идемпотентность: один УСПЕШНЫЙ исход на ключ. Частичный индекс, а не
-- UNIQUE-колонка: провалившуюся задачу с тем же ключом можно завести заново.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_idempotency_succeeded
  ON agent_tasks(idempotency_key)
  WHERE idempotency_key IS NOT NULL AND state = 'succeeded';

CREATE INDEX IF NOT EXISTS idx_agent_tasks_state ON agent_tasks(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_trace ON agent_tasks(trace_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_capability ON agent_tasks(capability, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_events (
  id          BIGSERIAL PRIMARY KEY,
  task_id     UUID NOT NULL REFERENCES agent_tasks(id),
  trace_id    UUID NOT NULL,
  seq         INTEGER NOT NULL,
  event_type  VARCHAR(50) NOT NULL,   -- transition / effect_started / effect_committed / policy_denied / note
  from_state  VARCHAR(30),
  to_state    VARCHAR(30),
  actor       VARCHAR(200) NOT NULL,
  details     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_agent_events_trace ON agent_events(trace_id, id);

-- Append-only на уровне БД, не только тестом: UPDATE/DELETE по журналу
-- запрещены триггером. История — улика; правится она только новой строкой.
CREATE OR REPLACE FUNCTION agent_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent_events append-only: % запрещён', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_events_append_only ON agent_events;
CREATE TRIGGER trg_agent_events_append_only
  BEFORE UPDATE OR DELETE ON agent_events
  FOR EACH ROW EXECUTE FUNCTION agent_events_append_only();

COMMENT ON TABLE agent_tasks IS 'Agent Kernel v1: каноническая задача агента (identity, policy, lease, идемпотентность)';
COMMENT ON TABLE agent_events IS 'Agent Kernel v1: append-only журнал переходов и эффектов — UPDATE/DELETE режет триггер';
