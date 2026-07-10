-- Migration 738: пересоздание VIEW v_kamchatka_routes_api (после 734/736)
--
-- Все колонки, которые селектит view, уже добавлены: базовые давно, остальные
-- — миграцией 734 (kamchatka_routes ADD COLUMN, без places/FK — та часть 734
-- проходила), duration_days — миграцией 736. Поэтому CREATE VIEW проходит.
-- Отдельным файлом: даже если он упадёт, колонки из 734/736 уже на месте
-- (enrich работает), в отличие от 733, где падение view уносило колонки.
--
-- DROP+CREATE (не REPLACE): на проде мог остаться старый VIEW с иным набором
-- колонок. Зависимых объектов у v_kamchatka_routes_api нет — DROP безопасен.

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
