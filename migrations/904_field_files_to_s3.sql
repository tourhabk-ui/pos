-- 904: большие файлы полевой проверки уезжают в S3 (владелец 22.08).
--
-- Снимки я положил БАЙТАМИ В БАЗУ (миграция 899, колонка bytes BYTEA). Для
-- улики это неправильное место: пять снимков по мегабайту с каждого выхода
-- растят таблицу, попадают в каждый дамп и в каждую реплику, а отдаются
-- через прикладной роут вместо раздачи хранилища. У платформы S3 подключён
-- и уже несёт снимки мест, туров и отзывов — полевые обязаны лежать там же.
--
-- `bytes` не удаляется и становится необязательным: снимки, уже принятые в
-- базу, никуда не деваются, а новые пишут URL. Ровно одно из двух полей
-- заполнено, и это проверяется ограничением — «ни того, ни другого» здесь
-- значило бы снимок, которого нет.
--
-- Отдельная таблица для треков из навигатора: MAPS.ME и Organic Maps отдают
-- KMZ/GPX одним файлом, и это самый дешёвый способ получить настоящую линию.
-- Файл кладётся в S3 целиком, а в базу — то, что по нему ИЗМЕРЕНО. Замер
-- рядом с файлом нужен, чтобы решать по нему, не разбирая архив заново.

ALTER TABLE route_field_check_photos
  ADD COLUMN IF NOT EXISTS s3_url TEXT,
  ADD COLUMN IF NOT EXISTS s3_key TEXT;

ALTER TABLE route_field_check_photos
  ALTER COLUMN bytes DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'route_field_check_photos_where_check'
  ) THEN
    ALTER TABLE route_field_check_photos
      ADD CONSTRAINT route_field_check_photos_where_check
      CHECK (bytes IS NOT NULL OR s3_url IS NOT NULL);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS route_track_imports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Имя файла как его прислали: по нему человек узнаёт свой выход.
  source_name   TEXT,
  -- Род определён по СОДЕРЖИМОМУ, не по расширению.
  format        VARCHAR(8) NOT NULL CHECK (format IN ('gpx', 'kml', 'kmz')),
  s3_url        TEXT NOT NULL,
  s3_key        TEXT NOT NULL,
  byte_size     INTEGER NOT NULL CHECK (byte_size > 0),

  -- Измеренное по файлу. NULL законен: в файле может не быть линии вовсе,
  -- и тогда это метки, а не трек.
  points        INTEGER,
  length_km     NUMERIC(8,2),
  span_km       NUMERIC(8,2),
  -- Доля точек с высотой, 0..1. Ею §12 судит, запись это или перерисовка.
  ele_share     NUMERIC(3,2),
  step_min_m    INTEGER,
  step_median_m INTEGER,
  step_max_m    INTEGER,
  -- Сколько длилась запись, минуты. NULL — меток времени в файле нет:
  -- KML без gx:Track их не несёт вовсе (разведка Organic Maps 22.08).
  timespan_min  INTEGER,
  waypoints     INTEGER NOT NULL DEFAULT 0,

  -- К какой нашей записи файл ближе и на сколько расходится. NULL — не
  -- нашли или не смогли посчитать; это состояние, а не ноль.
  matched_route_id UUID REFERENCES kamchatka_routes(id) ON DELETE SET NULL,
  off_by_km        NUMERIC(8,2),

  -- Что помешало разобрать. Пусто — разобралось целиком.
  problems      TEXT[],
  note          TEXT CHECK (note IS NULL OR char_length(note) <= 600),
  trip_tag      VARCHAR(60),

  status        VARCHAR(10) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'rejected')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_route_track_imports_pending
  ON route_track_imports (created_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_route_track_imports_match
  ON route_track_imports (matched_route_id)
  WHERE matched_route_id IS NOT NULL;
