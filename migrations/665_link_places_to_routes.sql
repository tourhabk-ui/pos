-- 665_link_places_to_routes.sql
-- Связывает места (places) с маршрутами (kamchatka_routes) через route_waypoints.
--
-- Критерии совпадения (OR):
--   1. Название места встречается в заголовке маршрута (pg_trgm similarity >= 0.3)
--   2. Географическая близость: место в радиусе 15 км от координат маршрута
--
-- Безопасно: ON CONFLICT DO NOTHING — повторный запуск не дублирует данные.

-- Включаем pg_trgm для нечёткого поиска по названиям
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Вставляем связи по совпадению названий
INSERT INTO route_waypoints (route_id, place_id, position)
SELECT DISTINCT
  r.id   AS route_id,
  p.id   AS place_id,
  0      AS position
FROM kamchatka_routes r
JOIN places p ON (
  -- Совпадение по названию: слово из названия места есть в заголовке маршрута
  similarity(p.name, r.title) >= 0.3
  OR r.title ILIKE '%' || split_part(p.name, ' ', 1) || '%'
  OR (
    length(split_part(p.name, ' ', 1)) >= 6
    AND r.description ILIKE '%' || split_part(p.name, ' ', 1) || '%'
  )
)
WHERE p.lat IS NOT NULL AND p.lng IS NOT NULL
  AND r.lat IS NOT NULL AND r.lng IS NOT NULL
ON CONFLICT (route_id, place_id) DO NOTHING;

-- Вставляем связи по географической близости (радиус 15 км)
-- Haversine через SQL: 6371 * acos(cos(r1)*cos(r2)*cos(lng2-lng1)+sin(r1)*sin(r2)) <= 15
INSERT INTO route_waypoints (route_id, place_id, position)
SELECT DISTINCT
  r.id AS route_id,
  p.id AS place_id,
  1    AS position
FROM kamchatka_routes r
JOIN places p ON (
  -- Быстрый фильтр по bbox перед точным расчётом
  p.lat BETWEEN r.lat - 0.15 AND r.lat + 0.15
  AND p.lng BETWEEN r.lng - 0.25 AND r.lng + 0.25
  -- Точный Haversine ≤ 15 км
  AND 6371 * 2 * ASIN(SQRT(
    POWER(SIN((RADIANS(p.lat) - RADIANS(r.lat)) / 2), 2) +
    COS(RADIANS(r.lat)) * COS(RADIANS(p.lat)) *
    POWER(SIN((RADIANS(p.lng) - RADIANS(r.lng)) / 2), 2)
  )) <= 15
)
WHERE p.lat IS NOT NULL AND p.lng IS NOT NULL
  AND r.lat IS NOT NULL AND r.lng IS NOT NULL
ON CONFLICT (route_id, place_id) DO NOTHING;

-- Статистика после вставки
DO $$
DECLARE
  total_wp   INTEGER;
  linked_pl  INTEGER;
  total_pl   INTEGER;
BEGIN
  SELECT COUNT(*)              INTO total_wp  FROM route_waypoints;
  SELECT COUNT(DISTINCT place_id) INTO linked_pl FROM route_waypoints;
  SELECT COUNT(*)              INTO total_pl  FROM places;
  RAISE NOTICE 'route_waypoints: % записей, % из % мест связано',
    total_wp, linked_pl, total_pl;
END $$;
