-- Migration 676: Comprehensive deduplication — places and kamchatka_routes
--
-- Problem: agent_route_knowledge is UNION ALL over places + kamchatka_routes.
-- Two sources of visible duplicates:
--   A) Same geographic point in BOTH places AND kamchatka_routes (cross-table)
--   B) Multiple entries in places with same name but coords off by > 0.0005°
--      (migration 675 safety net used ROUND(lat,3) ≈ 55m; this adds 0.003° ≈ 300m)
--
-- Strategy:
--   1. Within places: hide near-duplicates by name + coords within 300m
--      (extends migration 675's safety net which only caught exact-rounded coords)
--   2. Cross-table: hide kamchatka_routes entries that duplicate a places entry
--      (no geometry track, no waypoints, same name + coords ≤500m)
--   3. Within kamchatka_routes: same-title + close-coords duplicates
--
-- All uses is_visible = false (soft-delete, fully reversible).

-- ── 1a. Within places: same name + extended radius (300m) ─────────────────
--
-- Extends migration 675 safety net (ROUND(lat,3) ≈ 55m) to catch same-name
-- places imported with slightly different coordinates.

UPDATE places p
SET is_visible = false
WHERE p.is_visible = true
  AND p.lat IS NOT NULL
  AND p.lng IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM places p2
    WHERE p2.is_visible = true
      AND p2.ark_id != p.ark_id
      AND LOWER(TRIM(p2.name)) = LOWER(TRIM(p.name))
      AND ABS(p2.lat - p.lat) < 0.003
      AND ABS(p2.lng - p.lng) < 0.003
      AND (
        COALESCE(LENGTH(p2.description), 0) > COALESCE(LENGTH(p.description), 0)
        OR (
          COALESCE(LENGTH(p2.description), 0) = COALESCE(LENGTH(p.description), 0)
          AND p2.id > p.id
        )
      )
  );

-- ── 1b. Within places: same location_type + very close coords (≤200m) ────────
--
-- Catches same-place entries with DIFFERENT names, e.g.:
--   "Авачинская сопка" vs "Авачинский вулкан" vs "Авачинский вулкан: путь..."
-- Safe for single-point geographic features (volcano, mountain, lake, etc.)
-- because two DISTINCT features of the same type won't sit within 200m.
-- Excludes hot_spring and geyser (thermal fields can have multiple distinct
-- springs within a small area).

UPDATE places p
SET is_visible = false
WHERE p.is_visible = true
  AND p.lat IS NOT NULL
  AND p.lng IS NOT NULL
  AND p.location_type IN (
    'volcano', 'mountain', 'lake', 'bay', 'island',
    'rock', 'cape', 'waterfall', 'glacier', 'valley'
  )
  AND EXISTS (
    SELECT 1 FROM places p2
    WHERE p2.is_visible = true
      AND p2.ark_id != p.ark_id
      AND p2.location_type = p.location_type
      AND ABS(p2.lat - p.lat) < 0.002
      AND ABS(p2.lng - p.lng) < 0.002
      AND (
        COALESCE(LENGTH(p2.description), 0) > COALESCE(LENGTH(p.description), 0)
        OR (
          COALESCE(LENGTH(p2.description), 0) = COALESCE(LENGTH(p.description), 0)
          AND p2.id > p.id
        )
      )
  );

-- ── 2. Cross-table: hide kamchatka_routes that duplicate a places entry ────────
--
-- Conditions:
--   a) No geometry track (not a real route with a path)
--   b) No waypoints (not a multi-stop route)
--   c) Matching places entry: same name (case-insensitive) + coords within 500m

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
      AND LOWER(TRIM(p.name)) = LOWER(TRIM(r.title))
      AND ABS(p.lat - r.lat) < 0.005
      AND ABS(p.lng - r.lng) < 0.005
  );

-- ── 3. Cross-table: hide kamchatka_routes with exact same coordinates ──────────
--
-- Some entries have same-rounded coords but slightly different names
-- (e.g. "Вулкан Корякский" vs "Корякский вулкан"). If coordinates match to 3dp
-- AND the route has no geometry/waypoints — hide it (places is master).

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

-- ── 4. Within kamchatka_routes: same title + close coords ─────────────────────
--
-- For pairs of routes with same title and coords within 500m,
-- hide the one with less description content (lower id as tiebreaker).

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
