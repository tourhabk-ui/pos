-- Migration 670: создание VIEW v_kamchatka_routes_api для публичного доступа к маршрутам
-- Created: 2026-06-04

BEGIN;

-- ============================================================
-- Публичный VIEW — скрывает is_visible=false и legacy-поля
-- ============================================================

CREATE OR REPLACE VIEW v_kamchatka_routes_api AS
SELECT
  id,
  ark_id,
  title,
  description,
  category,
  activity_type,
  zone,
  lat,
  lng,
  source_url,
  source_name,
  difficulty,
  distance_km,
  duration_hours,
  elevation_gain_m,
  season,
  route_type,
  is_visible,
  view_count,
  geometry,
  hazards,
  equipment,
  mchs_registration_required,
  park_name,
  park_approval_url,
  flora_fauna,
  accessibility,
  mchs_phone,
  duration_days,
  created_at,
  updated_at
FROM kamchatka_routes
WHERE is_visible = true OR is_visible IS NULL;

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP VIEW IF EXISTS v_kamchatka_routes_api;
-- COMMIT;
