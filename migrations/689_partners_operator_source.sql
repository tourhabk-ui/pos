-- Migration 689: Add external source fields to partners table
-- Allows storing official operators from visitkamchatka.ru with their contacts
-- and Telegram group links for availability monitoring

ALTER TABLE partners ADD COLUMN IF NOT EXISTS external_source VARCHAR(50);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS external_source_url TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS external_id VARCHAR(100);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS telegram_group_url TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS license_number VARCHAR(100);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS services TEXT[];
ALTER TABLE partners ADD COLUMN IF NOT EXISTS external_rating NUMERIC(3,1);

CREATE INDEX IF NOT EXISTS idx_partners_external_source
  ON partners(external_source)
  WHERE external_source IS NOT NULL;
