-- Migration 694: Add missing columns to partners table
-- These columns are referenced by admin API but were never formally migrated.
-- slug was used informally, hero_image/logo_image are for direct URL storage,
-- short_description for card previews, location for geo info, is_public for visibility.

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS slug              VARCHAR(255),
  ADD COLUMN IF NOT EXISTS short_description TEXT,
  ADD COLUMN IF NOT EXISTS hero_image        TEXT,
  ADD COLUMN IF NOT EXISTS logo_image        TEXT,
  ADD COLUMN IF NOT EXISTS location          JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_public         BOOLEAN NOT NULL DEFAULT TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_partners_slug
  ON partners (slug)
  WHERE slug IS NOT NULL;
