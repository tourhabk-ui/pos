-- 863: Версия маршрута — редакция линии и точек, к которой привязываются
--      полевой пакет и share-ссылка (план Field Confidence Navigator, этап 1).
--
-- Зачем: «маршрут» на экране — это конкретная редакция геометрии и waypoints.
-- Скачанный полевой пакет и отправленный группе брифинг обязаны говорить,
-- К КАКОЙ редакции они относятся: линия могла поменяться после закачки.
--
-- Инкремент — триггером, а не в коде: путей записи geometry/waypoints в
-- кодовой базе десяток (импортёры idilesom/OSM/GPX/KML, dem-backfill,
-- admin-правки, dedup), и правило, реализованное в каждом из них, — это
-- десять правил, которые разойдутся. Триггер покрывает и будущие пути.
--
-- Идемпотентно: IF NOT EXISTS / OR REPLACE / DROP IF EXISTS.

ALTER TABLE kamchatka_routes
  ADD COLUMN IF NOT EXISTS route_version INT NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION bump_route_version() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'kamchatka_routes' THEN
    -- Правка самой линии: версия поднимается в той же строке.
    NEW.route_version := COALESCE(OLD.route_version, 1) + 1;
    RETURN NEW;
  END IF;
  -- Правка состава/порядка точек: поднимаем версию родительского маршрута.
  -- Рекурсии нет: этот UPDATE не трогает geometry, а триггер на
  -- kamchatka_routes слушает только UPDATE OF geometry.
  UPDATE kamchatka_routes
     SET route_version = route_version + 1
   WHERE id = COALESCE(NEW.route_id, OLD.route_id);
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_route_version_geometry ON kamchatka_routes;
CREATE TRIGGER trg_route_version_geometry
  BEFORE UPDATE OF geometry ON kamchatka_routes
  FOR EACH ROW
  WHEN (OLD.geometry IS DISTINCT FROM NEW.geometry)
  EXECUTE FUNCTION bump_route_version();

DROP TRIGGER IF EXISTS trg_route_version_waypoints ON route_waypoints;
CREATE TRIGGER trg_route_version_waypoints
  AFTER INSERT OR UPDATE OR DELETE ON route_waypoints
  FOR EACH ROW
  EXECUTE FUNCTION bump_route_version();
