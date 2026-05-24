-- Migration 676: Cross-table deduplication — kamchatka_routes vs places
--
-- Problem: agent_route_knowledge is UNION ALL over places + kamchatka_routes.
-- During data migration some geographic points ended up in BOTH tables,
-- causing them to appear twice in the map, search, and trending endpoints.
--
-- Strategy:
--   1. Hide kamchatka_routes entries that duplicate a places entry
--      (same name + coords within 0.005°≈500m, no geometry track, no waypoints).
--      `places` is the master for geographic points per architecture.
--   2. Hide within-table kamchatka_routes duplicates
--      (same title + close coords — keep the one with most description content).
--   3. Fix kamchatka_routes entries missing is_visible that should be visible.
--
-- All operations use is_visible = false (soft-delete, fully reversible).

-- ── 1. Cross-table: hide kamchatka_routes that duplicate a places entry ───────
--
-- Conditions:
--   a) kamchatka_routes has NO geometry track (geometry IS NULL or empty JSON)
--   b) kamchatka_routes has NO waypoints (not a real multi-stop route)
--   c) A matching places entry exists: same name (case-insensitive, trimmed)
--      AND coordinates within 0.005 degrees (~500m)

UPDATE kamchatka_routes r
SET is_visible = false
WHERE r.is_visible = true
  AND r.lat IS NOT NULL
  AND r.lng IS NOT NULL
  -- No real geometry track
  AND (
    r.geometry IS NULL
    OR r.geometry::text = 'null'
    OR r.geometry::text = '{}'
    OR r.geometry::text = '[]'
  )
  -- No waypoints (this is a point, not a route)
  AND NOT EXISTS (
    SELECT 1 FROM route_waypoints rw WHERE rw.route_id = r.id
  )
  -- Matching places entry exists
  AND EXISTS (
    SELECT 1 FROM places p
    WHERE p.is_visible = true
      AND p.lat IS NOT NULL
      AND p.lng IS NOT NULL
      AND LOWER(TRIM(p.name)) = LOWER(TRIM(r.title))
      AND ABS(p.lat - r.lat) < 0.005
      AND ABS(p.lng - r.lng) < 0.005
  );

-- ── 2. Cross-table: also hide exact coordinate duplicates (rounded to 3dp) ────
--
-- Some entries have same-rounded coords but slightly different names
-- (e.g. "Вулкан Корякский" vs "Корякский вулкан"). Hide the route entry
-- if coords match to 3dp AND the route has no geometry/waypoints.

UPDATE kamchatka_routes r
SET is_visible = false
WHERE r.is_visible = true
  AND r.lat IS NOT NULL
  AND r.lng IS NOT NULL
  AND (
    r.geometry IS NULL
    OR r.geometry::text = 'null'
    OR r.geometry::text = '{}'
    OR r.geometry::text = '[]'
  )
  AND NOT EXISTS (
    SELECT 1 FROM route_waypoints rw WHERE rw.route_id = r.id
  )
  AND EXISTS (
    SELECT 1 FROM places p
    WHERE p.is_visible = true
      AND p.lat IS NOT NULL
      AND p.lng IS NOT NULL
      AND ROUND(p.lat::numeric, 3) = ROUND(r.lat::numeric, 3)
      AND ROUND(p.lng::numeric, 3) = ROUND(r.lng::numeric, 3)
  );

-- ── 3. Within kamchatka_routes: hide duplicates (same title + close coords) ───
--
-- For pairs of routes with same title (case-insensitive) and coords within
-- 0.005°, hide the one with less description content (lower id as tiebreaker).

UPDATE kamchatka_routes r
SET is_visible = false
WHERE r.is_visible = true
  AND r.lat IS NOT NULL
  AND r.lng IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM kamchatka_routes r2
    WHERE r2.is_visible = true
      AND r2.id != r.id
      AND r2.lat IS NOT NULL
      AND r2.lng IS NOT NULL
      AND LOWER(TRIM(r2.title)) = LOWER(TRIM(r.title))
      AND ABS(r2.lat - r.lat) < 0.005
      AND ABS(r2.lng - r.lng) < 0.005
      AND (
        COALESCE(LENGTH(r2.description), 0) > COALESCE(LENGTH(r.description), 0)
        OR (
          COALESCE(LENGTH(r2.description), 0) = COALESCE(LENGTH(r.description), 0)
          AND r2.id > r.id
        )
      )
  );
