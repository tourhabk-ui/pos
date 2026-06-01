-- Migration 685: заполнить kamchatka_routes.hazards[] по location_type и activity_type
-- Created: 2026-06-01

BEGIN;

-- ============================================================
-- Seed hazards для маршрутов у которых массив пустой или NULL
-- Логика приоритетов (от специфичного к общему):
--   1. bear_watching                    → медведи + дикая природа
--   2. Вулканический location_type      → камнепад, высота, погода, вулк. газы
--   3. Термальный location_type/activity → термальные зоны
--   4. Река / сплав / морская прогулка  → переправы
--   5. Вертолёт                         → нет (погода контролируется пилотом)
--   6. Треккинг/горы (volcano/mountain) → медведи + высота
--   7. Треккинг/пешее по умолчанию     → медведи + погода
--   8. Всё остальное                    → дикая природа + погода
-- ============================================================

UPDATE kamchatka_routes
SET hazards = CASE
  -- Наблюдение за медведями
  WHEN activity_type = 'bear_watching'
    THEN ARRAY['bears', 'wildlife']::TEXT[]

  -- Вулканы (location_type)
  WHEN location_type IN ('volcano', 'geyser')
    THEN ARRAY['rockfall', 'altitude', 'weather', 'volcanic_gas']::TEXT[]

  -- Термальные источники
  WHEN location_type IN ('hot_spring', 'thermal')
       OR activity_type = 'thermal'
    THEN ARRAY['thermal']::TEXT[]

  -- Реки / сплав / морские прогулки
  WHEN location_type = 'river'
       OR activity_type IN ('boat_trip', 'rafting')
    THEN ARRAY['river_crossing', 'weather']::TEXT[]

  -- Треккинг через вулканические или горные зоны
  WHEN activity_type IN ('trekking', 'hiking', 'eco')
       AND location_type IN ('volcano', 'mountain', 'glacier')
    THEN ARRAY['bears', 'altitude', 'weather']::TEXT[]

  -- Общий треккинг / пешие маршруты
  WHEN activity_type IN ('trekking', 'hiking', 'eco', 'camping')
    THEN ARRAY['bears', 'weather']::TEXT[]

  -- Рыбалка
  WHEN activity_type = 'fishing'
    THEN ARRAY['bears', 'wildlife', 'river_crossing']::TEXT[]

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
