-- 1447: заявка внешнего ИИ-агента ждёт, пока её отправит сам человек.
--
-- Задача #3399, п. 4; слово владельца 15.11 «Делай» на предложение: заявка
-- MCP и A2A уходит только после того, как человек на странице Ведара увидел,
-- что и кому уйдёт, и нажал «Отправить». До этого согласие на передачу имени
-- и телефона заявлял агент (флаг consent, затем код подтверждения, который
-- тот же агент и гасил — ревью безопасности #3414).
--
-- Строка — отложенная заявка: инструмент, его аргументы (с именем и
-- телефоном), черновик для страницы (без ПД), ревизия плана, если заявка по
-- плану (правка плана после черновика — отправки нет), и откуда пришла
-- (mcp | a2a). Ссылка человеку несёт токен; в базе — только его sha256.
--
-- ПД здесь живут, пока заявка ждёт: при отправке аргументы стираются в том же
-- запросе, что отмечает отправку; просроченные строки удаляет следующая
-- запись (lib/mcp/pending-request). Дольше срока ссылки (60 минут) и суток
-- после него имя и телефон здесь не лежат.
--
-- Идемпотентна: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS mcp_pending_requests (
  id            BIGSERIAL PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  tool          TEXT NOT NULL,
  args          JSONB NOT NULL,
  draft_text    TEXT NOT NULL,
  plan_revision TEXT,
  via           TEXT NOT NULL DEFAULT 'mcp' CHECK (via IN ('mcp', 'a2a')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  sent_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mcp_pending_requests_expires_idx ON mcp_pending_requests (expires_at);

COMMENT ON TABLE mcp_pending_requests IS
  'Заявка внешнего агента (MCP/A2A) до нажатия «Отправить» человеком на /confirm (#3399, п. 4). args — с ПД, стираются при отправке; просроченные строки удаляются.';
