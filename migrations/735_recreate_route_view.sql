-- Migration 735: пересоздание VIEW v_kamchatka_routes_api (после 734)
--
-- Отдельно от колонок (734): к моменту 735 все селектируемые колонки уже
-- закоммичены миграцией 734, поэтому CREATE VIEW гарантированно проходит.
-- Даже если 735 по какой-то причине упадёт — колонки из 734 уже на месте
-- (enrich-passports и прямые чтения работают), в отличие от 733, где падение
-- view уносило и колонки.
--
-- DROP+CREATE (не REPLACE): на проде мог остаться старый VIEW с иным набором/
-- порядком колонок, CREATE OR REPLACE на таком падает. Зависимых объектов у
-- v_kamchatka_routes_api нет (проверено) — DROP без CASCADE безопасен.

BEGIN;

DROP VIEW IF EXISTS v_kamchatka_routes_api;
CREATE VIEW v_kamchatka_routes_api AS
SELECT
  id, ark_id, title, description, category, activity_type, zone, lat, lng,
  source_url, source_name, difficulty, distance_km, duration_hours,
  elevation_gain_m, season, route_type, is_visible, view_count, geometry,
  hazards, equipment, mchs_registration_required, park_name, park_approval_url,
  flora_fauna, accessibility, mchs_phone, duration_days, created_at, updated_at
FROM kamchatka_routes
WHERE is_visible = true OR is_visible IS NULL;

COMMIT;
