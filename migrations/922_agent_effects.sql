-- 922: Volcano OS — agent_effects, отложенная в 917 «отдельным этапом».
--
-- 917 (agent_kernel.sql:16-21) назвала окно вслух: связка событий
-- effect_started/effect_committed даёт наблюдаемость, но НЕ exactly-once —
-- окно сбоя между внешним commit (создание PR, отправка сообщения) и
-- записью события остаётся. Эта миграция закрывает окно там, где его
-- можно закрыть: durable intent ДО вызова внешнего API, атомарный переход
-- в committed/failed ПОСЛЕ.
--
-- effect_key — идемпотентность конкретной ПОПЫТКИ эффекта в рамках задачи
-- (не задачи целиком — у задачи может быть несколько разных эффектов).
-- UNIQUE(task_id, effect_key): повторный beginEffect с тем же ключом видит
-- существующую строку вместо второй попытки — committed возвращается как
-- факт (не повторять), pending — честная неопределённость (§4.0): предыдущая
-- попытка либо ещё идёт, либо упала между внешним вызовом и commitEffect,
-- и это узнать нельзя изнутри самой этой таблицы.

CREATE TABLE IF NOT EXISTS agent_effects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID NOT NULL REFERENCES agent_tasks(id),
  effect_key    VARCHAR(300) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed','failed')),
  external_ref  TEXT,
  details       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  committed_at  TIMESTAMPTZ,
  UNIQUE (task_id, effect_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_effects_pending
  ON agent_effects(created_at)
  WHERE status = 'pending';

COMMENT ON TABLE agent_effects IS
  'Volcano OS: durable intent внешнего эффекта (beginEffect/commitEffect/failEffect) — закрывает окно между внешним commit и записью события, отложенное в 917';
COMMENT ON COLUMN agent_effects.effect_key IS
  'Идемпотентность попытки эффекта в рамках задачи — не самой задачи (UNIQUE task_id+effect_key)';
