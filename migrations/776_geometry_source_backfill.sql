-- Migration 776: маркер источника геометрии — бэкфилл синтетики
--
-- Канон маркера: in-band ключ 'source' ВНУТРИ GeoJSON (geometry->>'source').
-- Конвенция уже в бою: idilesom- и visitkamchatka-импортёры пишут его, дедуп
-- idilesom-скрипта читает ('idilesom'/'osm' = реальный трек). Новой колонки
-- не заводим: при слияниях дублей (data-repair, COALESCE по geometry) маркер
-- едет вместе с геометрией сам.
--
-- Проблема: синтетика миграции 168 (прямые линии по waypoints) не помечена,
-- поэтому OSM-импорт не мог отличить её от реальных треков и не апгрейдил,
-- хотя комментарий 168-й это обещал ("Real OSM tracks will always override").
--
-- Сигнатура синтетики (обе проверки вместе, чтобы не зацепить реальный трек):
--  1) первая координата ТОЧНО равна [lng, lat] маршрута — migration 168 писала
--     jsonb_build_array(lng::float, lat::float) первой точкой; реальные треки
--     начинаются с узла OSM/GPX, не с точки маршрута;
--  2) точек мало (waypoints+1, единицы) — реальные треки несут десятки-сотни.
-- Треки с уже проставленным source не трогаем (идемпотентно).

UPDATE kamchatka_routes
SET geometry = geometry || jsonb_build_object('source', 'waypoints_synthetic')
WHERE geometry IS NOT NULL
  AND geometry->>'type' = 'LineString'
  AND geometry->>'source' IS NULL
  AND lat IS NOT NULL AND lng IS NOT NULL
  AND jsonb_array_length(geometry->'coordinates') <= 12
  AND (geometry->'coordinates'->0->>0)::float8 = lng::float8
  AND (geometry->'coordinates'->0->>1)::float8 = lat::float8;

-- Геометрия без source и без сигнатуры синтетики — реальный трек неизвестного
-- происхождения (старые OSM/GPX-прогоны не маркировали). Оставляем без метки
-- сознательно: отсутствие source = "настоящий трек, источник не зафиксирован",
-- в пул апгрейда такие НЕ попадают.

INSERT INTO _migrations (name)
VALUES ('776_geometry_source_backfill.sql')
ON CONFLICT (name) DO NOTHING;
