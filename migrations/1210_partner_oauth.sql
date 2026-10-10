-- Migration 1210: MCP партнёра — вход по OAuth для приложения Claude (#2325, 1д-2)
-- Created: 2026-10-10
--
-- Ключ из кабинета (1203) работает там, где клиент умеет заголовок
-- Authorization: Claude Code, Cursor, API, свои агенты. Приложение Claude
-- (сайт, десктоп, телефон) заголовок принимает только у части организаций —
-- это бета; у обычного партнёра на Free/Pro путь один: OAuth. Документация
-- Anthropic, «Authentication for connectors», сверено 10.10.
--
-- Подключение по OAuth — та же строка partner_api_keys, что ключ: тот же
-- поиск по хешу на каждом запросе, тот же отзыв в кабинете, та же отметка
-- «агент заходил». Отличия только в сроках:
--   * oauth_client_id — кто подключён (client_id CIMD: адрес документа
--     клиента на claude.ai). NULL — ключ, выпущенный в кабинете;
--   * key_hash у OAuth-строки — хеш ТОКЕНА ДОСТУПА, он живёт час
--     (access_expires_at) и меняется при каждом обновлении;
--   * refresh_hash — хеш токена обновления; ротация: при обновлении старый
--     перестаёт действовать в том же UPDATE (OAuth 2.1 для публичных
--     клиентов). refresh_expires_at — 90 дней с последнего обновления.
-- Самих токенов в базе нет, как и ключей.
--
-- partner_oauth_codes — одноразовый код авторизации: живёт 5 минут,
-- расходуется DELETE ... RETURNING (второй раз не выдать по построению),
-- привязан к client_id, redirect_uri и PKCE-вызову (S256). В базе — хеш кода.
--
-- Производители и потребители — в этом же PR (правило 10.09):
-- lib/crm/partner-oauth.ts пишет и читает обе таблицы, роут MCP партнёра
-- проверяет срок доступа, кабинет показывает подключение и отзывает его.

BEGIN;

ALTER TABLE partner_api_keys ADD COLUMN IF NOT EXISTS oauth_client_id TEXT;
ALTER TABLE partner_api_keys ADD COLUMN IF NOT EXISTS refresh_hash CHAR(64);
ALTER TABLE partner_api_keys ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ;
ALTER TABLE partner_api_keys ADD COLUMN IF NOT EXISTS refresh_expires_at TIMESTAMPTZ;

-- Строка — либо ключ кабинета (сроков нет), либо подключение OAuth (все три
-- срока и хеш обновления есть). Смесь означала бы ключ, который истекает
-- без способа обновиться, или токен без срока.
ALTER TABLE partner_api_keys DROP CONSTRAINT IF EXISTS partner_api_keys_oauth_shape;
ALTER TABLE partner_api_keys ADD CONSTRAINT partner_api_keys_oauth_shape CHECK (
  (oauth_client_id IS NULL AND refresh_hash IS NULL AND access_expires_at IS NULL AND refresh_expires_at IS NULL)
  OR (oauth_client_id IS NOT NULL AND refresh_hash IS NOT NULL AND access_expires_at IS NOT NULL AND refresh_expires_at IS NOT NULL)
);
ALTER TABLE partner_api_keys DROP CONSTRAINT IF EXISTS partner_api_keys_refresh_hex;
ALTER TABLE partner_api_keys ADD CONSTRAINT partner_api_keys_refresh_hex CHECK (refresh_hash IS NULL OR refresh_hash ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS partner_api_keys_refresh_hash_uniq
  ON partner_api_keys (refresh_hash) WHERE refresh_hash IS NOT NULL;

COMMENT ON COLUMN partner_api_keys.oauth_client_id IS
  'client_id подключения OAuth (адрес документа CIMD). NULL — ключ, выпущенный в кабинете.';
COMMENT ON COLUMN partner_api_keys.refresh_hash IS
  'sha256 токена обновления (hex). Меняется при каждом обновлении — старый перестаёт действовать.';
COMMENT ON COLUMN partner_api_keys.access_expires_at IS
  'Когда истекает токен доступа OAuth (час). У ключа кабинета — NULL, срока нет.';
COMMENT ON COLUMN partner_api_keys.refresh_expires_at IS
  'Когда истекает токен обновления OAuth (90 дней с последнего обновления).';

CREATE TABLE IF NOT EXISTS partner_oauth_codes (
  code_hash       CHAR(64) PRIMARY KEY,
  partner_id      UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  client_id       TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  can_write       BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT partner_oauth_codes_hash_hex CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT partner_oauth_codes_challenge_shape CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$')
);

COMMENT ON TABLE partner_oauth_codes IS
  'Одноразовые коды авторизации OAuth MCP партнёра (5 минут, PKCE S256). Хранится только хеш кода.';

-- Уборка просроченных кодов при каждой выдаче — по сроку.
CREATE INDEX IF NOT EXISTS partner_oauth_codes_expires_idx ON partner_oauth_codes (expires_at);

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS partner_oauth_codes;
-- DELETE FROM partner_api_keys WHERE oauth_client_id IS NOT NULL;
-- ALTER TABLE partner_api_keys DROP CONSTRAINT IF EXISTS partner_api_keys_oauth_shape;
-- ALTER TABLE partner_api_keys DROP CONSTRAINT IF EXISTS partner_api_keys_refresh_hex;
-- DROP INDEX IF EXISTS partner_api_keys_refresh_hash_uniq;
-- ALTER TABLE partner_api_keys DROP COLUMN IF EXISTS refresh_expires_at;
-- ALTER TABLE partner_api_keys DROP COLUMN IF EXISTS access_expires_at;
-- ALTER TABLE partner_api_keys DROP COLUMN IF EXISTS refresh_hash;
-- ALTER TABLE partner_api_keys DROP COLUMN IF EXISTS oauth_client_id;
-- COMMIT;
