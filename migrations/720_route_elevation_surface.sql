-- Migration 720: высотный профиль и покрытие маршрута (задача L)
--
-- Конкурентный разбор показал два поля, критичных для оценки сложности,
-- которых у нас нет: тип покрытия и полный высотный профиль (gain уже был).
-- Профиль считается скриптом scripts/compute-elevation-profile.ts из
-- 3-й компоненты координат geometry (GPS-треки); синтетические LineString
-- из waypoints высот не имеют — у таких маршрутов поля честно NULL.
--
-- surface_types — контролируемый словарь (валидация в коде):
-- paved | dirt_road | trail | prepared_trail | off_trail | coastal | water.
--
-- Идемпотентна: safe to run multiple times.

BEGIN;

ALTER TABLE kamchatka_routes
  ADD COLUMN IF NOT EXISTS surface_types    TEXT[],
  ADD COLUMN IF NOT EXISTS elevation_loss_m INT,
  ADD COLUMN IF NOT EXISTS elevation_min_m  INT,
  ADD COLUMN IF NOT EXISTS elevation_max_m  INT;

COMMIT;
