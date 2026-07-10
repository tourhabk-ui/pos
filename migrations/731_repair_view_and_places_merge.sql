-- Migration 731: ремонт схемы — v_kamchatka_routes_api и places.merged_into_id
--
-- Скриншоты владельца (июль 2026): на проде падают ровно те запросы, что
-- ходят в VIEW v_kamchatka_routes_api (health-метрики «Треки маршрутов»,
-- «Контакты МЧС») и в places.merged_into_id (поиск в «Фото мест», HTTP 500),
-- при этом запросы напрямую в kamchatka_routes работают. Наиболее вероятная
-- причина — дыры в схеме: bootstrap трекинга миграций на новом инстансе
-- (scripts/bootstrap-migrations-tracking.ts) мог пометить старые миграции
-- применёнными без фактического прогона (670 — VIEW, 706 — merged_into_id).
--
-- Миграция полностью идемпотентна: если схема цела — все операторы no-op
-- (CREATE OR REPLACE VIEW пересоздаст view в том же виде, ADD COLUMN IF NOT
-- EXISTS пропустится). Если дыра есть — закроет её.

BEGIN;

-- ── 706: мягкое слияние дублей places ────────────────────────────────────
ALTER TABLE places ADD COLUMN IF NOT EXISTS merged_into_id UUID REFERENCES places(id);
ALTER TABLE places ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_places_merged_into ON places(merged_into_id) WHERE merged_into_id IS NOT NULL;

-- ── 670: публичный VIEW маршрутов (актуальное определение) ───────────────
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
