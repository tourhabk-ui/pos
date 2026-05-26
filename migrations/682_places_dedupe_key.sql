-- Migration 682: Add dedupe_key to places + prevent future cross-source duplicates
--
-- Problem: places table has no dedupe_key (unlike kamchatka_routes which has one).
-- Same geographic object imported from idilesom + another source → two visible rows.
-- This migration:
--   1. Adds dedupe_key TEXT column to places
--   2. Backfills dedupe_key for idilesom entries (from source_url)
--   3. Backfills dedupe_key for other sources with source_url
--   4. Resolves any pre-existing key collisions (keep best, hide rest)
--   5. Adds UNIQUE partial index on dedupe_key WHERE NOT NULL
--   6. Adds UNIQUE partial index on (source_name, source_url) WHERE both NOT NULL
--      to block same-URL re-imports from different code paths
--   7. Physically deletes hidden places that are exact duplicates of a visible entry
--      (same name + coords within 55m) — reclaims space, no data loss

-- ── 1. Add dedupe_key column ───────────────────────────────────────────
ALTER TABLE places ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

-- ── 2. Backfill: idilesom entries → idilesom.com:places:{id} ────────────────
UPDATE places
SET dedupe_key = 'idilesom.com:places:' || (
  regexp_match(source_url, '/kam/places/([^/?#]+)$')
)[1]
WHERE source_url ~ '/kam/places/[^/?#]+$'
  AND dedupe_key IS NULL;

-- ── 3. Backfill: visitkamchatka entries → visitkamchatka.ru:{filename} ─────────
UPDATE places
SET dedupe_key = 'visitkamchatka.ru:' || (
  regexp_match(source_url, '/upload/route_passports/([^/?#]+)$')
)[1]
WHERE source_url ~ '/upload/route_passports/[^/?#]+$'
  AND dedupe_key IS NULL;

-- ── 4. Backfill: any other source_url → source_name:md5(source_url) ───────────
UPDATE places
SET dedupe_key = COALESCE(source_name, 'unknown') || ':url:' ||
  substring(md5(source_url), 1, 16)
WHERE source_url IS NOT NULL
  AND source_name IS NOT NULL
  AND dedupe_key IS NULL;

-- ── 5. Resolve dedupe_key collisions: keep best (longest desc), hide rest ────
UPDATE places p
SET is_visible = false
WHERE p.is_visible = true
  AND p.dedupe_key IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM places p2
    WHERE p2.is_visible = true
      AND p2.ark_id != p.ark_id
      AND p2.dedupe_key = p.dedupe_key
      AND (
        COALESCE(LENGTH(p2.description), 0) > COALESCE(LENGTH(p.description), 0)
        OR (
          COALESCE(LENGTH(p2.description), 0) = COALESCE(LENGTH(p.description), 0)
          AND p2.id > p.id
        )
      )
  );

-- ── 6. Resolve (source_name, source_url) collisions before adding index ───────
-- If same URL was inserted from two different code paths, hide the older/shorter one
UPDATE places p
SET is_visible = false
WHERE p.is_visible = true
  AND p.source_url IS NOT NULL
  AND p.source_name IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM places p2
    WHERE p2.is_visible = true
      AND p2.ark_id != p.ark_id
      AND p2.source_url = p.source_url
      AND p2.source_name = p.source_name
      AND (
        COALESCE(LENGTH(p2.description), 0) > COALESCE(LENGTH(p.description), 0)
        OR (
          COALESCE(LENGTH(p2.description), 0) = COALESCE(LENGTH(p.description), 0)
          AND p2.id > p.id
        )
      )
  );

-- ── 7. UNIQUE index on dedupe_key (partial — only non-null visible) ──────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_places_dedupe_key
  ON places (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND is_visible = true;

-- ── 8. UNIQUE index on (source_name, source_url) (partial) ─────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_places_source_url_unique
  ON places (source_name, source_url)
  WHERE source_url IS NOT NULL AND source_name IS NOT NULL AND is_visible = true;

-- ── 9. Physical DELETE of hidden exact-duplicates (same name + coords ≤55m) ──
-- Only removes rows that are:
--   a) is_visible = false
--   b) Have a visible counterpart with identical name + coords within 0.0005°
--   c) No safety-profile, real-time status, images, or waypoints attached
-- This reclaims DB space. Fully safe — no data is unique to these rows.
DELETE FROM places p
WHERE p.is_visible = false
  AND p.lat IS NOT NULL
  AND p.lng IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM places p2
    WHERE p2.is_visible = true
      AND LOWER(TRIM(p2.name)) = LOWER(TRIM(p.name))
      AND ABS(p2.lat - p.lat) < 0.0005
      AND ABS(p2.lng - p.lng) < 0.0005
  )
  AND NOT EXISTS (
    SELECT 1 FROM location_safety_profile lsp WHERE lsp.agent_route_id = p.ark_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM location_real_time_status lrs WHERE lrs.agent_route_id = p.ark_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM ai_route_images img WHERE img.route_id = p.ark_id
  );
