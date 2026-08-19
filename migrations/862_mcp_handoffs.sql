-- 862: MCP handoff — мост «ответ агента → действие человека на Ведаре»
-- (этап 2 плана метрик MCP, чертёж владельца 15.08).
-- В URL и в БД нет ПД: хранится только SHA-256 случайного токена; имя,
-- телефон, промпт и аргументы инструментов сюда не попадают by construction.

CREATE TABLE IF NOT EXISTS mcp_handoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Только хеш. Сырой token существует ровно между генерацией и ответом MCP.
  token_hash CHAR(64) NOT NULL UNIQUE,

  -- Связка с телеметрией MCP; не содержит ПД.
  mcp_session_id TEXT NULL,
  mcp_invocation_id UUID NULL,
  tool_name TEXT NOT NULL,

  -- Только относительный путь, созданный доверенным серверным кодом.
  target_path TEXT NOT NULL CHECK (target_path LIKE '/%'),
  target_type TEXT NOT NULL CHECK (target_type IN ('planner', 'plan', 'tour', 'place', 'safety')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  first_opened_at TIMESTAMPTZ NULL,
  last_opened_at TIMESTAMPTZ NULL,
  open_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS mcp_handoffs_live_idx
  ON mcp_handoffs (expires_at)
  WHERE first_opened_at IS NULL;

CREATE TABLE IF NOT EXISTS mcp_handoff_events (
  id BIGSERIAL PRIMARY KEY,
  handoff_id UUID NOT NULL REFERENCES mcp_handoffs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('issued', 'opened', 'attributed_action')),
  action_type TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mcp_handoff_events_handoff_idx
  ON mcp_handoff_events (handoff_id, created_at DESC);
