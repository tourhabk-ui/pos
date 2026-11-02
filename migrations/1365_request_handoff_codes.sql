-- Migration 1365: одноразовый код продолжения заявки в другом канале
-- Created: 2026-11-02
--
-- Владелец 02.11: «письмо потом кодь» — связь каналов (MAX / сайт / Telegram)
-- только одноразовым кодом, без телефона и имени. В базе — хеш кода и номер
-- ключа заявки (agent_request_keys), больше ничего. Код живёт 30 минут и
-- гасится при первом предъявлении.
CREATE TABLE IF NOT EXISTS request_handoff_codes (
  id              BIGSERIAL   PRIMARY KEY,
  code_hash       CHAR(64)    NOT NULL UNIQUE,
  request_key_id  UUID        NOT NULL REFERENCES agent_request_keys(id) ON DELETE CASCADE,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at         TIMESTAMPTZ NULL,
  used_channel    TEXT        NULL
);
CREATE INDEX IF NOT EXISTS request_handoff_codes_key_idx
  ON request_handoff_codes (request_key_id) WHERE used_at IS NULL;

-- Rollback:
-- DROP TABLE IF EXISTS request_handoff_codes;
