-- 1219: журнал запросов A2A — кто приходит по второму протоколу.
--
-- Решение владельца 12.10: «я бы хотел видеть в админ-хабе A2A, хотя бы кто
-- заходит из ИИ». До этого дня след A2A был неполным: вызов инструмента через
-- DataPart уходил в mcp_tool_calls тем же путём, что MCP, и от MCP-вызова ничем
-- не отличался; текстовый вопрос Кузьмичу не писался нигде; чтение визитки с
-- /api/a2a и /api/a2a/v1 не считал никто. Строка «в журнале A2A будут его
-- вопросы» (lib/a2a/catalogs.ts) описывала журнал, которого не было.
--
-- Сырой User-Agent и IP НЕ хранятся — та же граница, что у mcp_clients (872) и
-- agent_entry_hits (1218). У A2A нет рукопожатия с clientInfo, поэтому «кто»
-- берётся из заголовка, но не целиком: только самоназвание программы
-- (`A2A-Registry-TaskProbe`, `python-requests`, `GPTBot`) без версии,
-- платформы и комментариев в скобках; браузер остаётся «браузер». Текст
-- вопроса, аргументы инструмента и contextId в открытом виде не пишутся:
-- в них могут быть имя и телефон туриста (152-ФЗ). caller_hash — тот же
-- суточный hash, что у журнала MCP (lib/mcp/call-log): журналы соединяются
-- по дню, длинного профиля по-прежнему нет.
--
-- Пишет lib/a2a/journal.ts (fire-and-forget, отказ — в лог с SQLSTATE),
-- читает /api/admin/analytics/a2a → /hub/admin/a2a.

CREATE TABLE IF NOT EXISTS a2a_requests (
  id               BIGSERIAL    PRIMARY KEY,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- биндинг: jsonrpc (/api/a2a) или rest (/api/a2a/v1)
  binding          VARCHAR(8)   NOT NULL,
  -- операция: card, SendMessage, GetTask, CancelTask, ListTasks,
  -- GetExtendedAgentCard, notification, invalid (отказ до диспетчера)
  op               VARCHAR(32)  NOT NULL,
  -- версия протокола: 1.0 или 0.3; при отказе по версии — что просили
  version          VARCHAR(8)   NOT NULL,
  version_declared BOOLEAN      NOT NULL DEFAULT FALSE,
  -- ответ протокола: true — result, false — ошибка A2A/JSON-RPC (error_code)
  ok               BOOLEAN      NOT NULL,
  error_code       VARCHAR(40),
  -- вид входа SendMessage: text (вопрос Кузьмичу) или tool (DataPart)
  input            VARCHAR(8),
  -- инструмент из реестра; 'unknown' — просили несуществующий
  tool             VARCHAR(64),
  -- состояние задачи: completed, rejected, failed
  state            VARCHAR(16),
  duration_ms      INTEGER,
  -- самоназвание программы из заголовка (lib/a2a/journal agentLabel), не UA целиком
  agent            VARCHAR(64)  NOT NULL,
  -- род по заголовку — та же таксономия, что mcp_clients.ua_family
  ua_family        VARCHAR(24)  NOT NULL,
  -- суточный hash вызывающего (lib/mcp/call-log mcpCallerHash)
  caller_hash      VARCHAR(64)  NOT NULL,
  -- sha256 от contextId, 32 знака: считать диалоги, не читать их
  context_key      VARCHAR(32),
  -- свой клиент (метка владельца в адресе), как is_self у mcp_tool_calls
  is_self          BOOLEAN      NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_a2a_requests_created_at
  ON a2a_requests (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_a2a_requests_agent_created
  ON a2a_requests (agent, created_at DESC);

COMMENT ON TABLE a2a_requests IS
  'Журнал запросов A2A (/api/a2a, /api/a2a/v1): биндинг, операция, версия, вид входа, инструмент, исход, самоназвание программы; User-Agent, IP, текст и аргументы не хранятся';
