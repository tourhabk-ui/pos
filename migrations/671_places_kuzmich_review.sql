-- Migration 671: добавить kuzmich_review в places и kamchatka_routes
-- Created: 2026-06-04

BEGIN;

ALTER TABLE places
  ADD COLUMN IF NOT EXISTS kuzmich_review TEXT;

ALTER TABLE kamchatka_routes
  ADD COLUMN IF NOT EXISTS kuzmich_review TEXT;

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE places DROP COLUMN IF EXISTS kuzmich_review;
-- ALTER TABLE kamchatka_routes DROP COLUMN IF EXISTS kuzmich_review;
-- COMMIT;
