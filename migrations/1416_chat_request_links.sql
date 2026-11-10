-- Migration 1416: связь «чат мессенджера ↔ заявка» для «Моей поездки» (#2970)
-- Created: 2026-11-10
--
-- Владелец 10.11: «Моя поездка» в чате Кузьмича (MAX и Telegram) — заявки,
-- привязанные к ЭТОМУ чату, их статус и обстановка на даты; кнопка — после
-- первой заявки. До этой миграции связи не было: заявка, созданная Кузьмичом
-- в чате общим с MCP путём, id чата не писала вовсе, а в Telegram чат знал
-- заявку только у запроса мест.
--
-- Связь — с КЛЮЧОМ заявки (agent_request_keys), а не с самой заявкой: статус
-- читается по номеру ключа без сырого ключа (REQUEST_STATUS_BY_KEY_IDS_SQL),
-- и истёкший ключ (90 дней) сам уводит заявку из списка. Строку пишет только
-- тот, кто ключ ПРЕДЪЯВИЛ или ПОЛУЧИЛ в этом чате: заявка создана здесь
-- (created), открыта ссылкой переписки (sq), погашен код между каналами
-- (handoff), вставлена ссылка статуса (status_link). По телефону и имени
-- связь не ищется и не пишется. ПД в таблице нет: канал, id чата, номер ключа.
CREATE TABLE IF NOT EXISTS chat_request_links (
  id          BIGSERIAL   PRIMARY KEY,
  channel     TEXT        NOT NULL CHECK (channel IN ('max', 'telegram')),
  chat_id     TEXT        NOT NULL CHECK (chat_id <> '' AND length(chat_id) <= 64),
  key_id      UUID        NOT NULL REFERENCES agent_request_keys(id) ON DELETE CASCADE,
  origin      TEXT        NOT NULL CHECK (origin IN ('created', 'sq', 'handoff', 'status_link')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel, chat_id, key_id)
);
CREATE INDEX IF NOT EXISTS chat_request_links_chat_idx
  ON chat_request_links (channel, chat_id, created_at DESC);

-- Rollback:
-- DROP TABLE IF EXISTS chat_request_links;
