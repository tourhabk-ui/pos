-- Migration 1203: CRM фаза 1, шаг 1д-2 — ключи MCP партнёра (#2325)
-- Created: 2026-10-10
--
-- Партнёр подключает к своей CRM собственного ИИ-агента (Claude, ChatGPT,
-- любой клиент MCP) по адресу /api/mcp/partner и ключу из кабинета. Условия
-- владельца (карт-бланш на 1д): ключ хранится хешем и показывается один раз;
-- отзывается в кабинете; по умолчанию — только чтение; в ответах — contact_id
-- и подпись «Анна П.», без телефонов и почт (lib/crm/tools.ts).
--
-- Колонки — только с производителем и потребителем в этом же PR (10.09):
--   * key_hash — sha256 ключа; самого ключа в базе нет нигде, утечка
--     таблицы ключей не даёт входа (lib/crm/agent-keys.ts);
--   * key_prefix — начало ключа («vdr_pk_ab12cd»): опознать ключ в списке
--     кабинета, не храня его;
--   * can_write — право записи (касание, задача, выполнение); по умолчанию
--     нет: включает партнёр при выпуске ключа;
--   * last_used_at — когда агент заходил последний раз; пишет роут MCP,
--     читает список ключей в кабинете;
--   * revoked_at / revoked_by — отзыв: ключ остаётся строкой (кабинет
--     показывает, что он был и когда отозван), но не пускает.
-- Журнала вызовов здесь нет намеренно: читателя у него пока не было бы.
-- Партнёрские вызовы НЕ пишутся в mcp_tool_calls — та таблица считает
-- публичный канал (сторож молчания MCP, перепись спроса), и чужие вызовы
-- исказили бы её.
--
-- Задача, заведённая агентом партнёра, помечается origin = 'mcp' — его
-- производитель (инструмент crm_add_task с ключом на запись) в этом же PR.

BEGIN;

CREATE TABLE IF NOT EXISTS partner_api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  key_prefix    TEXT NOT NULL,
  key_hash      CHAR(64) NOT NULL,
  can_write     BOOLEAN NOT NULL DEFAULT FALSE,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  revoked_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT partner_api_keys_hash_uniq UNIQUE (key_hash),
  CONSTRAINT partner_api_keys_label_len CHECK (char_length(label) BETWEEN 1 AND 60),
  CONSTRAINT partner_api_keys_hash_hex CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT partner_api_keys_revoked_pair CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL)
);

COMMENT ON TABLE partner_api_keys IS 'Ключи MCP партнёра к своей CRM (шаг 1д-2, #2325). Ключ хранится только хешем.';
COMMENT ON COLUMN partner_api_keys.key_hash IS 'sha256 ключа (hex). Сам ключ показывается партнёру один раз и нигде не хранится.';
COMMENT ON COLUMN partner_api_keys.key_prefix IS 'Начало ключа для опознания в списке кабинета.';
COMMENT ON COLUMN partner_api_keys.can_write IS 'Право записи в CRM (касание, задача, выполнение). По умолчанию — только чтение.';

-- Действующие ключи партнёра — список в кабинете и предел на число ключей.
CREATE INDEX IF NOT EXISTS partner_api_keys_partner_active_idx
  ON partner_api_keys (partner_id) WHERE revoked_at IS NULL;

ALTER TABLE crm_tasks DROP CONSTRAINT IF EXISTS crm_tasks_origin_check;
ALTER TABLE crm_tasks ADD CONSTRAINT crm_tasks_origin_check CHECK (origin IN ('manual', 'kuzmich', 'mcp'));

COMMENT ON COLUMN crm_tasks.origin IS
  'Кто завёл: manual — человек в кабинете; kuzmich — Кузьмич в чате партнёра (1д-1); mcp — агент партнёра по ключу (1д-2).';

COMMIT;

-- Rollback:
-- BEGIN;
-- UPDATE crm_tasks SET origin = 'manual' WHERE origin = 'mcp';
-- ALTER TABLE crm_tasks DROP CONSTRAINT IF EXISTS crm_tasks_origin_check;
-- ALTER TABLE crm_tasks ADD CONSTRAINT crm_tasks_origin_check CHECK (origin IN ('manual', 'kuzmich'));
-- DROP TABLE IF EXISTS partner_api_keys;
-- COMMIT;
