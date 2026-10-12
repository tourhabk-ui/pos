-- 1220: ключи статуса заявки для агентов (ступень 1 агентного контура, #2371).
--
-- После заявки через MCP или A2A агент не мог узнать ничего: ответ пишущего
-- инструмента намеренно не называет номер заявки — совпавший номер был бы
-- оракулом «этот телефон уже просил этот тур на эту дату» (проверка MCP
-- 29.09), — а страница статуса с ключом есть только у запроса мест. Здесь
-- случайный ключ на КАЖДЫЙ вызов пишущего инструмента: он не номер и ничего
-- не говорит о том, новая заявка или повторная; по нему get_request_status
-- отдаёт состояние без персональных данных.
--
-- Хранится только SHA-256 ключа (как у mcp_handoffs, 862); сырой ключ живёт
-- ровно между генерацией и ответом инструмента. Имя, телефон и текст заявки
-- сюда не попадают by construction: только ссылка на лид или на запрос мест.

CREATE TABLE IF NOT EXISTS agent_request_keys (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash         CHAR(64)    NOT NULL UNIQUE,
  lead_id          UUID        NULL REFERENCES leads(id) ON DELETE CASCADE,
  seat_request_id  UUID        NULL REFERENCES tour_seat_requests(id) ON DELETE CASCADE,
  tool_name        TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  last_read_at     TIMESTAMPTZ NULL,
  read_count       INTEGER     NOT NULL DEFAULT 0,
  CONSTRAINT agent_request_keys_one_target
    CHECK (((lead_id IS NOT NULL)::int + (seat_request_id IS NOT NULL)::int) = 1)
);

CREATE INDEX IF NOT EXISTS agent_request_keys_lead_idx
  ON agent_request_keys (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_request_keys_seat_idx
  ON agent_request_keys (seat_request_id) WHERE seat_request_id IS NOT NULL;
