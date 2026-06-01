-- Migration 685: заполнить kamchatka_routes.hazards[] по category и activity_type
-- Created: 2026-06-01
-- Note: kamchatka_routes has no location_type column — we use category + activity_type instead.

BEGIN;

-- ============================================================
-- Seed hazards для маршрутов у которых массив пустой или NULL
-- Логика приоритетов (от специфичного к общему):
--   1. bear_watching / medvedi          → медведи + дикая природа
--   2. Вулканы / гейзеры (category)    → камнепад, высота, погода, вулк. газы
--   3. Термальные (category/activity)  → термальные зоны
--   4. Реки / сплав / морские прогулки → переправы
--   5. Рыбалка                         → медведи + реки
--   6. Треккинг / горы / eco           → медведи + погода
--   7. Всё остальное                   → дикая природа + погода
-- ============================================================

UPDATE kamchatka_routes
SET hazards = CASE

  -- Наблюдение за медведями
  WHEN activity_type = 'bear_watching'
       OR category = 'medvedi'
    THEN ARRAY['bears', 'wildlife']::TEXT[]

  -- Вулканы и гейзеры
  WHEN category IN ('vulkani', 'geyzery')
    THEN ARRAY['rockfall', 'altitude', 'weather', 'volcanic_gas']::TEXT[]

  -- Термальные источники
  WHEN category = 'termalnye_istochniki'
       OR activity_type = 'thermal'
    THEN ARRAY['thermal']::TEXT[]

  -- Реки / сплав / морские прогулки
  WHEN category = 'rivers'
       OR activity_type IN ('boat_trip', 'rafting')
       OR category = 'morskie_progulki'
    THEN ARRAY['river_crossing', 'weather']::TEXT[]

  -- Рыбалка
  WHEN activity_type = 'fishing'
       OR category = 'rybalka'
    THEN ARRAY['bears', 'wildlife', 'river_crossing']::TEXT[]

  -- Треккинг / пешее / горы / eco
  WHEN activity_type IN ('trekking', 'hiking', 'eco', 'camping')
       OR category IN ('trekking', 'mountains', 'eco')
    THEN ARRAY['bears', 'weather']::TEXT[]

  -- Всё остальное (снегоходы, джипы, вертолёты, фото и т.д.)
  ELSE ARRAY['wildlife', 'weather']::TEXT[]

END
WHERE hazards IS NULL OR hazards = '{}'::TEXT[] OR array_length(hazards, 1) IS NULL;

COMMIT;

-- Rollback:
-- BEGIN;
-- UPDATE kamchatka_routes SET hazards = NULL
-- WHERE hazards && ARRAY['rockfall','altitude','volcanic_gas','thermal','river_crossing','bears','wildlife','weather']::TEXT[];
-- COMMIT;
