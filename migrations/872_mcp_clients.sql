-- 872: кто звал MCP — по самопредставлению клиента, а не по слежке.
--
-- Журнал 861 отвечает «зовут ли, что зовут, ломается ли». На вопрос «какой
-- именно ИИ обращался» он не отвечает и не должен был: там суточный hash от
-- IP+UA, из которого клиента не достать (152-ФЗ, тот же приём, что в
-- page_views).
--
-- Но узнать можно без всякой слежки: по протоколу MCP клиент представляется
-- САМ — `initialize` несёт `clientInfo: {name, version}`. Это имя ПРОГРАММЫ
-- («claude-ai», «Claude Code», «cursor»), а не человека: персональными
-- данными оно не является и модель суточного hash не ломает.
--
-- Ключ — (caller_hash, day): та же суточная граница, что у журнала вызовов.
-- Длинного профиля не строится by design, на следующий день hash другой.

CREATE TABLE IF NOT EXISTS mcp_clients (
  caller_hash    VARCHAR(64)  NOT NULL,
  day            DATE         NOT NULL,
  -- имя из clientInfo, приведённое и обрезанное; NULL — клиент не представился
  client_name    VARCHAR(64),
  client_version VARCHAR(32),
  -- род клиента по User-Agent: запасной ответ, когда initialize не звали
  ua_family      VARCHAR(24),
  first_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (caller_hash, day)
);

CREATE INDEX IF NOT EXISTS idx_mcp_clients_day
  ON mcp_clients (day DESC);
