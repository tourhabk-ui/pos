-- 899: фотографии полевой проверки.
--
-- Владелец 21.08: «форма должна быть PWA и возможность загрузить фото».
-- Фотография — единственная улика, которая не спорит: снимок развилки
-- решает вопрос о том, куда идёт тропа, надёжнее любого описания.
--
-- Хранение в БД (BYTEA), а не в файловой системе: контейнер на Timeweb
-- эфемерен — public/uploads исчезает при каждом деплое, и улика с ним.
-- S3 в этом окружении может быть не настроен (isS3Configured), а молчаливо
-- терять фотографии из поля недопустимо. Объёмы малы: снимок сжимается на
-- телефоне до ~1280 px и кладётся ограниченным по размеру.
--
-- ON DELETE CASCADE: фотография без проверки — сирота без смысла.

CREATE TABLE IF NOT EXISTS route_field_check_photos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id    UUID NOT NULL REFERENCES route_field_checks(id) ON DELETE CASCADE,
  mime        VARCHAR(32) NOT NULL CHECK (mime IN ('image/jpeg', 'image/webp', 'image/png')),
  bytes       BYTEA NOT NULL,
  byte_size   INTEGER NOT NULL CHECK (byte_size > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_field_check_photos_check
  ON route_field_check_photos (check_id);
