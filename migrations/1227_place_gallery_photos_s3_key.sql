-- 1227: галерея места — ключ объекта в хранилище (s3_key) и CHECK, который его знает.
--
-- Решение владельца 13.10: «согласен, перенеси в S3» — снимки, вшитые в миграции
-- hex-литералами (59 файлов, 154 JPEG, 24,7 МБ), уходят в хранилище под ключами
-- migrations/photos/<sha256>.jpg (маркер .github/triggers/migration-photos-to-s3.json,
-- заливка с раннера с чтением обратно). У героя (ai_route_images) ключ есть с 944;
-- у галереи (place_gallery_photos, 968) была только s3_url — полный адрес с именем
-- бакета, которого в репозитории нет. Ключ пишет миграция, адрес собирает раздача
-- (lib/storage/s3: s3PublicUrl) — тот же порядок, что у клипов туров (1194).
--
-- На чистой базе ту же колонку и CHECK заводит сам 968 (переписан 13.10): переписанные
-- 977+ пишут s3_key раньше, чем дошла бы эта миграция. Здесь — для прода, где 968
-- применён давно. Обе формы идемпотентны.
--
-- IDEMPOTENT

ALTER TABLE place_gallery_photos
  ADD COLUMN IF NOT EXISTS s3_key TEXT;

COMMENT ON COLUMN place_gallery_photos.s3_key IS
  'Ключ объекта в хранилище (migrations/photos/<sha256>.jpg или places/<ark_id>/…); адрес собирает раздача из S3_BUCKET. NULL — снимок в image_data или по s3_url.';

ALTER TABLE place_gallery_photos
  DROP CONSTRAINT IF EXISTS place_gallery_photos_has_image;
ALTER TABLE place_gallery_photos
  ADD CONSTRAINT place_gallery_photos_has_image
  CHECK (image_data IS NOT NULL OR s3_url IS NOT NULL OR s3_key IS NOT NULL);
