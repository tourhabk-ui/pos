-- 917: наблюдение переезжает с главной на экран маршрута (решение владельца 27.08).
--
-- На экране «На маршруте» у наблюдения появляется правильный контекст:
-- координаты и офлайн-статус система знает сама, человеку остаются
-- категория, описание и фото. Отсюда два изменения схемы:
--
-- 1. Категории полевой формы — «Животное, Растение, Опасность, Тропа,
--    Другое» (мокап владельца). Старые значения bear/rockfall/weather
--    остаются законными: радар и существующие записи их используют,
--    ломать историю ради новой формы нельзя.
--
-- 2. Фотографии наблюдений — trail_report_photos, точное зеркало
--    route_field_check_photos (899 + 904): снимок принимается отдельным
--    запросом, S3 при настроенном хранилище, BYTEA-фолбэк иначе.
--    ON DELETE CASCADE: снимок без наблюдения — сирота без смысла.
--
-- Идемпотентна: CHECK пересоздаётся только если старый ещё стоит.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'trail_reports_report_type_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%animal%'
  ) THEN
    ALTER TABLE trail_reports DROP CONSTRAINT trail_reports_report_type_check;
    ALTER TABLE trail_reports ADD CONSTRAINT trail_reports_report_type_check
      CHECK (report_type IN (
        'bear', 'rockfall', 'weather', 'other',
        'animal', 'plant', 'hazard', 'trail'
      ));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS trail_report_photos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id   UUID NOT NULL REFERENCES trail_reports(id) ON DELETE CASCADE,
  mime        VARCHAR(32) NOT NULL CHECK (mime IN ('image/jpeg', 'image/webp', 'image/png')),
  bytes       BYTEA,
  byte_size   INTEGER NOT NULL CHECK (byte_size > 0),
  s3_url      TEXT,
  s3_key      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Снимок обязан где-то лежать: либо байты в базе, либо адрес в S3.
  CONSTRAINT trail_report_photos_where CHECK (bytes IS NOT NULL OR s3_url IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_trail_report_photos_report
  ON trail_report_photos (report_id);
