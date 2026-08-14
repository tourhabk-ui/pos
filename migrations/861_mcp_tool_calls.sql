-- 861: журнал вызовов MCP-инструментов (Рост-6 — наблюдаемость MCP-канала).
-- vedar-mcp — четвёртый измеряемый канал (оценка 14.08): без журнала о нём
-- известно только то, что он существует. Пишем ФАКТ вызова: инструмент,
-- исход, длительность, суточный hash вызывающего.
-- АРГУМЕНТЫ НЕ ПИШЕМ НИКОГДА: в create_lead/create_booking_request лежат
-- имя и телефон туриста (152-ФЗ) — журналу они не нужны.

CREATE TABLE IF NOT EXISTS mcp_tool_calls (
  id BIGSERIAL PRIMARY KEY,
  tool VARCHAR(64) NOT NULL,
  ok BOOLEAN NOT NULL,
  -- rate_limited | unknown_tool | execution — почему не ok (NULL при успехе)
  error_kind VARCHAR(32),
  duration_ms INT,
  -- суточный hash IP+UA с секретной солью — тот же приём, что page_views:
  -- считаем "человеко-дни", длинный профиль не строим
  caller_hash VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_created
  ON mcp_tool_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_tool
  ON mcp_tool_calls (tool, created_at DESC);
