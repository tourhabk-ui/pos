-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1155: Скалы Три Брата — три кадра владельца платформы с борта судна
-- Created: 2026-10-03
--
-- Владелец 03.10: «скалы 3 брата, девушку можешь обрезать, фото моё». На
-- исходниках (4032x1960) справа у леера — человек; кадр 3:4 (решение 01.10)
-- взят окном 1470x1960 по скалам, левее неё, — в кадр она не попадает ни на
-- одном. Внизу остаются леер, спасательный круг и буй: снято с палубы, и
-- это честно. Герой 960x1280, галерея 810x1080, JPEG q72.
--
-- Почему живая запись e265d0f0, а не fd3feffa, как в 961: 961 положила
-- снимок владельца скрытому двойнику (проба 673: fd3feffa — 404, у e265d0f0
-- images: [], photoCount: 0). Карточка скал сегодня без единого кадра.
--
-- Герой встаёт только поверх снимка без ручного происхождения (как в 1147).
-- Галерея — позиции 1-2. Исход называется вслух блоком в конце.

BEGIN;

-- ── 1. Герой ──────────────────────────────────────────────────────────────
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'Скалы Три Брата у входа в Авачинскую бухту, вид с борта судна',
       'manual-upload',
       960,
       1280,
       'владелец платформы',
       'migrations/photos/463fbaaebb9fdcb0f8a1928b51097e38ae2cf10712e2d6e21f44768bd423e7ed.jpg'
  FROM places p
 WHERE p.id::text = 'e265d0f0-8187-4d7a-b0e4-fe9be5a2d9e0'
   AND p.ark_id IS NOT NULL
 LIMIT 1
ON CONFLICT (route_id) DO UPDATE
   SET image_data = EXCLUDED.image_data,
       mime_type  = EXCLUDED.mime_type,
       prompt     = EXCLUDED.prompt,
       model      = EXCLUDED.model,
       width      = EXCLUDED.width,
       height     = EXCLUDED.height,
       author     = EXCLUDED.author,
       license    = NULL,
       license_url = NULL,
       source_url = NULL,
       s3_url     = NULL,
       s3_key     = EXCLUDED.s3_key,
       created_at = NOW()
 WHERE ai_route_images.model NOT IN ('wikimedia', 'manual-upload')
    OR ai_route_images.prompt = EXCLUDED.prompt;

-- ── 2.1. Галерея, позиция 1 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       1,
       NULL::bytea,
       'image/jpeg',
       810,
       1080,
       'Скалы Три Брата с борта судна, вход в Авачинскую бухту',
       'владелец платформы',
       'migrations/photos/1bdc91b9bb660a0894792b10f0a5ced05f8b183d3e1f7fab5528b392b5df0236.jpg'
  FROM places p
 WHERE p.id::text = 'e265d0f0-8187-4d7a-b0e4-fe9be5a2d9e0'
   AND p.ark_id IS NOT NULL
 LIMIT 1
ON CONFLICT (ark_id, position) DO UPDATE
   SET image_data = EXCLUDED.image_data,
       s3_key     = EXCLUDED.s3_key,
       mime_type  = EXCLUDED.mime_type,
       width      = EXCLUDED.width,
       height     = EXCLUDED.height,
       caption    = EXCLUDED.caption,
       author     = EXCLUDED.author,
       s3_url     = NULL,
       created_at = NOW()
 WHERE place_gallery_photos.caption = EXCLUDED.caption;

-- ── 2.2. Галерея, позиция 2 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       2,
       NULL::bytea,
       'image/jpeg',
       810,
       1080,
       'Три Брата на закатном свету, вид с палубы',
       'владелец платформы',
       'migrations/photos/3141c794058f1195a049a5cfbc0d7c7c7ee3c940d58dabe783dff4ae3543d362.jpg'
  FROM places p
 WHERE p.id::text = 'e265d0f0-8187-4d7a-b0e4-fe9be5a2d9e0'
   AND p.ark_id IS NOT NULL
 LIMIT 1
ON CONFLICT (ark_id, position) DO UPDATE
   SET image_data = EXCLUDED.image_data,
       s3_key     = EXCLUDED.s3_key,
       mime_type  = EXCLUDED.mime_type,
       width      = EXCLUDED.width,
       height     = EXCLUDED.height,
       caption    = EXCLUDED.caption,
       author     = EXCLUDED.author,
       s3_url     = NULL,
       created_at = NOW()
 WHERE place_gallery_photos.caption = EXCLUDED.caption;

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_ark    uuid;
  v_author text;
  v_count  int;
BEGIN
  SELECT ark_id INTO v_ark FROM places
   WHERE id::text = 'e265d0f0-8187-4d7a-b0e4-fe9be5a2d9e0' AND is_visible AND merged_into_id IS NULL;

  IF v_ark IS NULL THEN
    RAISE WARNING '[1155] живой записи «Скалы Три Брата» нет — снимки не легли';
    RETURN;
  END IF;

  SELECT author INTO v_author FROM ai_route_images WHERE route_id = v_ark;
  IF v_author IS DISTINCT FROM 'владелец платформы' THEN
    RAISE WARNING '[1155] герой «Скалы Три Брата» НЕ встал: там %', COALESCE('автор «' || v_author || '»', 'строки снимка нет');
  END IF;

  SELECT COUNT(*) INTO v_count FROM place_gallery_photos
   WHERE ark_id = v_ark AND author = 'владелец платформы' AND position IN (1, 2);
  IF v_count <> 2 THEN
    RAISE WARNING '[1155] галерея «Скалы Три Брата»: легло % из 2 кадров владельца', v_count;
  END IF;
END $$;

COMMIT;
