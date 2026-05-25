-- Migration 673: Fix remaining placeholder coordinates + bbox constraint
-- Камчатский bbox: lat 50–62, lng 154–170 (включая Командорские острова)

BEGIN;

-- 1. Скрыть точки с placeholder-координатами (53.0444, 158.6483) которые ещё видимы
--    и не имеют реального описания мест ПКЦ (их координаты неизвестны, а не ПКЦ)
UPDATE places
SET is_visible = false,
    updated_at = NOW()
WHERE ROUND(lat::numeric, 4) = 53.0444
  AND ROUND(lng::numeric, 4) = 158.6483
  AND is_visible = true
  AND (
    -- скрываем если нет признаков что это реально ПКЦ-объект
    location_type NOT IN ('city', 'town', 'district', 'harbor', 'port', 'airport')
    OR location_type IS NULL
  );

-- 2. Скрыть точки вне bbox Камчатки (не видимые уже скрыты)
UPDATE places
SET is_visible = false,
    updated_at = NOW()
WHERE is_visible = true
  AND (
    lat::float < 50.0 OR lat::float > 62.0
    OR lng::float < 154.0 OR lng::float > 170.0
  );

-- 3. Добавить CHECK constraint для новых записей (предотвратить повтор)
ALTER TABLE places
  ADD CONSTRAINT chk_places_kamchatka_bbox
  CHECK (
    lat IS NULL OR lng IS NULL
    OR (lat::float BETWEEN 50.0 AND 62.0 AND lng::float BETWEEN 154.0 AND 170.0)
  )
  NOT VALID; -- NOT VALID = не проверяет существующие строки, только новые

-- 4. Аналогичный constraint для kamchatka_routes
ALTER TABLE kamchatka_routes
  ADD CONSTRAINT chk_routes_kamchatka_bbox
  CHECK (
    lat IS NULL OR lng IS NULL
    OR (lat::float BETWEEN 50.0 AND 62.0 AND lng::float BETWEEN 154.0 AND 170.0)
  )
  NOT VALID;

COMMIT;
