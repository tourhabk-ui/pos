-- Migration 777: починка битой синтетики миграции 168 + рабочий маркер
--
-- Диагностика (data-inventory 26.07, секция routes_synthetic_probe):
-- бэкфилл 776 нашёл 0 строк не из-за дрейфа координат, а потому что
-- миграция 168 породила БИТЫЙ GeoJSON. Она писала:
--   jsonb_build_array(lng, lat) || jsonb_agg(jsonb_build_array(...))
-- а оператор || у jsonb-массивов РАСПЛЮЩИВАЕТ левый операнд поэлементно:
--   [lng, lat, [x,y], [x,y], ...]  ← первые два элемента скаляры, не пара!
-- Такие «треки» не рендерились как линия и не матчились сигнатурой 776
-- (coordinates->0 — число, ->0->>0 даёт NULL).
--
-- Железная сигнатура синтетики 168: первый элемент coordinates — ЧИСЛО.
-- У любого реального трека (OSM/GPX/idilesom) первый элемент — пара [lng,lat].
--
-- Делаем два дела разом:
--  1) чиним структуру: [lng, lat, ...pairs] → [[lng,lat], ...pairs];
--  2) помечаем source='waypoints_synthetic' — маршрут попадает в пул
--     апгрейда OSM-импорта (реальный трек перекроет синтетику).
-- Идемпотентно: после починки coordinates->0 — массив, повторный прогон
-- не найдёт строк.

UPDATE kamchatka_routes
SET geometry = jsonb_set(
      geometry || jsonb_build_object('source', 'waypoints_synthetic'),
      '{coordinates}',
      jsonb_build_array(jsonb_build_array(
        geometry->'coordinates'->0,
        geometry->'coordinates'->1
      ))
      || ((geometry->'coordinates') - 0 - 0)
    )
WHERE geometry IS NOT NULL
  AND geometry->>'type' = 'LineString'
  AND geometry->>'source' IS NULL
  AND jsonb_typeof(geometry->'coordinates'->0) = 'number'
  AND jsonb_typeof(geometry->'coordinates'->1) = 'number';

INSERT INTO _migrations (name)
VALUES ('777_fix_synthetic_geometry_and_mark.sql')
ON CONFLICT (name) DO NOTHING;
