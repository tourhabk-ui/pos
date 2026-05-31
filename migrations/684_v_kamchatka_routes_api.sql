-- Migration 684: Persist v_kamchatka_routes_api view definition
-- This view is used in 10+ locations (trending, collections, routes/detail,
-- agent-market, kuzmich/core, slash-commands, etc.) but was never written
-- to a migration file. A DB reset or first deploy would break all those endpoints.
CREATE OR REPLACE VIEW v_kamchatka_routes_api AS
SELECT
  id, ark_id, title, description, category, activity_type,
  zone, lat, lng, source_url, source_name, difficulty,
  distance_km, duration_hours, elevation_gain_m,
  season, route_type, is_visible, view_count, geometry,
  hazards, equipment, mchs_registration_required, mchs_phone,
  park_name, park_approval_url, pdf_url,
  flora_fauna, accessibility,
  created_at, updated_at
FROM kamchatka_routes
WHERE is_visible = true OR is_visible IS NULL;
