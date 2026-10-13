-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1166: Сопка Никольская — два кадра Ильи Оноприйчука с Мишенной сопки
-- Created: 2026-10-04
--
-- Владелец 04.10: «Никольская сопка вид с Мишенной сопки автор Илья
-- Оноприйчук» — два кадра, летний и осенний. Исходники 6000x4000 и 4256x2832
-- (горизонтальные). По правилу 01.10 кадр места — 3:4: окно по высоте кадра,
-- по центру сопки (летний — x 900..3900, осенний — x 1341..3465), в кадре
-- остаются бухта, город и Петропавловская гавань. Герой 960x1280, галерея
-- 810x1080, JPEG q72, без EXIF (вместе с ним ушли бы данные камеры автора).
--
-- Проба 04.10 (prod-check run 92): у живой записи 51598b80 «Сопка
-- Никольская» images: [], photoCount: 0 — ни героя, ни галереи. Летний
-- кадр — герой (manual-upload, автор в подписи «Фото:»), осенний — позиция 1.
--
-- Герой встаёт только поверх снимка без ручного происхождения или поверх
-- самого себя (как 1155); галерея — только на пустую позицию или поверх
-- самой себя. Исход называется вслух блоком в конце.

BEGIN;

-- ── 1. Герой: лето ────────────────────────────────────────────────────────
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'Сопка Никольская и Петропавловская гавань с Мишенной сопки, лето',
       'manual-upload',
       960,
       1280,
       'Илья Оноприйчук',
       'migrations/photos/085ee4cf5f8518f25b39dbd9cbb6d63cf5978b84ab08eac231df709b6eda0c08.jpg'
  FROM places p
 WHERE p.id::text = '51598b80-6b92-48d9-beb4-019f824524c9'
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

-- ── 2. Галерея, позиция 1: осень ──────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       1,
       NULL::bytea,
       'image/jpeg',
       810,
       1080,
       'Сопка Никольская с Мишенной сопки, осень',
       'Илья Оноприйчук',
       'migrations/photos/aa5f5b5b042dfbf56498b5594269cd19174b3b88b1b5f0afdf2a2f115f6bec09.jpg'
  FROM places p
 WHERE p.id::text = '51598b80-6b92-48d9-beb4-019f824524c9'
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
  v_ark     uuid;
  v_hero    text;
  v_gallery text;
BEGIN
  SELECT ark_id INTO v_ark FROM places
   WHERE id::text = '51598b80-6b92-48d9-beb4-019f824524c9' AND is_visible AND merged_into_id IS NULL;
  IF v_ark IS NULL THEN
    RAISE WARNING '[1166] живой записи «Сопка Никольская» нет — кадры не легли';
    RETURN;
  END IF;
  SELECT author INTO v_hero FROM ai_route_images WHERE route_id = v_ark;
  IF v_hero IS DISTINCT FROM 'Илья Оноприйчук' THEN
    RAISE WARNING '[1166] герой у «Никольской» чужой: %', COALESCE('автор «' || v_hero || '»', 'строки нет');
  END IF;
  SELECT author INTO v_gallery FROM place_gallery_photos WHERE ark_id = v_ark AND position = 1;
  IF v_gallery IS DISTINCT FROM 'Илья Оноприйчук' THEN
    RAISE WARNING '[1166] позиция 1 у «Никольской» занята: %', COALESCE('автор «' || v_gallery || '»', 'строки нет');
  END IF;
END $$;

COMMIT;
