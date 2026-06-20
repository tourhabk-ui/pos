-- Migration 692: Add website column to partners
-- Stores the operator's own website URL (distinct from external_source_url
-- which is the visitkamchatka.ru listing page URL).
-- Used by operator-tour-scraper.ts to find and scrape tour pages.

ALTER TABLE partners ADD COLUMN IF NOT EXISTS website TEXT;

CREATE INDEX IF NOT EXISTS idx_partners_website ON partners(website)
  WHERE website IS NOT NULL;
