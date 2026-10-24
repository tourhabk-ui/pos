-- Migration 1329: суточный хэш адреса в page_views, без сырого IP
-- Created: 2026-10-24
--
-- Владелец 24.10: подозрение, что трафик суток пришёл с одного адреса.
-- Сырой IP в page_views не хранился (152-ФЗ, миграция 778). visitor_hash
-- мешает адрес с User-Agent и днём UTC, разложить его обратно на адреса
-- нельзя. Старые строки, включая 24.10, здесь не заполняются и не
-- переписываются: адреса у них нет.
--
-- ip_hash — sha256(камчатский день + соль + адрес), 32 hex. На следующие
-- сутки другой. anomaly_bot — строка стала ботом только из-за порога
-- «больше 30 просмотров за сутки и ни перехода, ни времени на странице».
-- FALSE у старых строк значит «правило их не метило», а не «проверено и чисто».

BEGIN;

ALTER TABLE page_views ADD COLUMN IF NOT EXISTS ip_hash TEXT;
ALTER TABLE page_views ADD COLUMN IF NOT EXISTS anomaly_bot BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN page_views.ip_hash IS
  'Суточный sha256(камчатский день + соль + адрес), не сырой IP. NULL — адрес не пришёл или строка старше колонки: восстановить нечем.';
COMMENT ON COLUMN page_views.anomaly_bot IS
  'TRUE — is_bot поставлен порогом просмотров за сутки без взаимодействия. Доклад времени или переход снимает только такие строки. FALSE у старых строк — правило их не метило.';

CREATE INDEX IF NOT EXISTS idx_page_views_ip_hash
  ON page_views (ip_hash, created_at)
  WHERE ip_hash IS NOT NULL;

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP INDEX IF EXISTS idx_page_views_ip_hash;
-- ALTER TABLE page_views DROP COLUMN IF EXISTS anomaly_bot;
-- ALTER TABLE page_views DROP COLUMN IF EXISTS ip_hash;
-- COMMIT;
