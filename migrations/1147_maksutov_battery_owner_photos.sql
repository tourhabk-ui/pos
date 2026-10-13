-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1147: Батарея Максутова — снимок и два кадра видео владельца платформы
--
-- Владелец 03.10: «батарея максутова фото и видео мое». Снимок (24.11.2018)
-- с ребёнком у пушки — ставится как есть: владелец согласовал это прямо
-- (вопрос 03.10, ответ «Ставить как есть»). Карточка места видео не
-- показывает, поэтому из ролика взяты два кадра: пушка на бухту и ряд
-- пушек вдоль дорожки. Все кадры 3:4 под героя карточки (решение 01.10).
--
-- Герой встаёт только поверх снимка без ручного происхождения (как в 1115):
-- чужой ручной снимок и Викисклад не перетираются. Галерея — позиции 1-2.
-- Исход называется вслух блоком в конце.

BEGIN;

-- ── 1. Герой ──────────────────────────────────────────────────────────────
-- Встаёт только поверх снимка без ручного происхождения: чужой ручной снимок
-- и снимок с Викисклада не перетираются (тот же предикат, что в 1115).
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'Батарея Максутова — пушка над Авачинской бухтой, ноябрь 2018',
       'manual-upload',
       960,
       1280,
       'владелец платформы',
       'migrations/photos/2e0ed46ce520907a6d9c3032e226c559fc289575a57d893fdfb61735f2f88f4f.jpg'
  FROM places p
 WHERE p.id::text = 'a2b3c4d5-e6f7-4890-bcde-f01234567890'
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
       'Пушка батареи нацелена на Авачинскую бухту',
       'владелец платформы',
       'migrations/photos/79094380f8eb69ad813225ce7718d38d161f26e19ab9096ef1a6fa4ae2f3898a.jpg'
  FROM places p
 WHERE p.id::text = 'a2b3c4d5-e6f7-4890-bcde-f01234567890'
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
       'Ряд пушек вдоль дорожки на батарее',
       'владелец платформы',
       'migrations/photos/bda08f9b697ec687d3a7b714636da0da38331c12038a311c8e1698f057c52656.jpg'
  FROM places p
 WHERE p.id::text = 'a2b3c4d5-e6f7-4890-bcde-f01234567890'
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
   WHERE id::text = 'a2b3c4d5-e6f7-4890-bcde-f01234567890' AND is_visible AND merged_into_id IS NULL;

  IF v_ark IS NULL THEN
    RAISE WARNING '[1147] живой записи «Батарея Максутова — позиция 1854 года» нет — снимки не легли';
    RETURN;
  END IF;

  SELECT author INTO v_author FROM ai_route_images WHERE route_id = v_ark;
  IF v_author IS DISTINCT FROM 'владелец платформы' THEN
    RAISE WARNING '[1147] герой «Батарея Максутова — позиция 1854 года» НЕ встал: там %', COALESCE('автор «' || v_author || '»', 'строки снимка нет');
  END IF;

  SELECT count(*) INTO v_count FROM place_gallery_photos
   WHERE ark_id = v_ark AND author = 'владелец платформы' AND position BETWEEN 1 AND 2;
  IF v_count <> 2 THEN
    RAISE WARNING '[1147] галерея «Батарея Максутова — позиция 1854 года»: легло % кадров из 2 (позиции заняты чужими подписями?)', v_count;
  END IF;
END $$;

COMMIT;
