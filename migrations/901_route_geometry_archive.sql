-- 901: линия маршрута не исчезает никогда.
--
-- Вопрос владельца 21.08: «как мне понять, какая из них верная, чтоб не
-- удалились правильные треки, которые есть в базе».
--
-- Правильный ответ на него — не обещание аккуратности, а устройство, при
-- котором неаккуратность ничего не стоит. Обещание забывается; триггер нет.
--
-- Всякая смена geometry у живого маршрута сама, до записи нового значения,
-- кладёт СТАРОЕ в архив. Не надо помнить о снимке, не надо просить об этом
-- миграцию, не надо доверять тому, кто её пишет: архивирует база.
-- Ошиблись — вернуть один UPDATE из архива, и линия та же, вершина в вершину.
--
-- Архивируется только фактическая смена: UPDATE, не менявший линию, ничего
-- не пишет (IS DISTINCT FROM), иначе архив забьётся пустыми копиями и в нём
-- нельзя будет найти ту самую версию.
--
-- Идемпотентна: CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE FUNCTION +
-- DROP TRIGGER IF EXISTS перед CREATE TRIGGER.

CREATE TABLE IF NOT EXISTS route_geometry_archive (
  id            BIGSERIAL PRIMARY KEY,
  route_id      UUID NOT NULL REFERENCES kamchatka_routes(id) ON DELETE CASCADE,
  -- Что было. NULL — законное значение: «линии не было» тоже состояние,
  -- и вернуть его надо уметь так же, как вернуть линию.
  geometry      JSONB,
  -- Источник и дистанция на момент снимка: без них возврат линии оставил бы
  -- при ней чужое число километров.
  source        TEXT,
  distance_km   NUMERIC,
  vertices      INT,
  archived_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_route_geometry_archive_route
  ON route_geometry_archive (route_id, archived_at DESC);

CREATE OR REPLACE FUNCTION archive_route_geometry() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.geometry IS DISTINCT FROM NEW.geometry THEN
    INSERT INTO route_geometry_archive (route_id, geometry, source, distance_km, vertices)
    VALUES (
      OLD.id,
      OLD.geometry,
      OLD.geometry->>'source',
      OLD.distance_km,
      CASE WHEN jsonb_typeof(OLD.geometry->'coordinates') = 'array'
           THEN jsonb_array_length(OLD.geometry->'coordinates')
           ELSE NULL END
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_archive_route_geometry ON kamchatka_routes;
CREATE TRIGGER trg_archive_route_geometry
  BEFORE UPDATE ON kamchatka_routes
  FOR EACH ROW
  EXECUTE FUNCTION archive_route_geometry();
