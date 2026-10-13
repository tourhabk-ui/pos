-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1128: «Водопад Спокойный» (он же Снежный Барс) — герой и два кадра Алины Гусаковой.
--
-- Владелец 30.09: «Водопад "Снежный Барс" Алина Гусакова» — три кадра.
-- В справочнике две записи под этот водопад: «Водопад Спокойный»
-- (a532f015 — 52.661/158.158; к нему привязаны маршруты «Водопад Спокойный (Снежный
-- Барс)», 882) и «Водопад Снежный барс» (0d08e60d, на 16 км западнее, со
-- снимком владельца). На вопрос, класть ли кадры на «Спокойный», владелец
-- 01.10: «да, но тоже адаптировать фото». Вторую запись эта миграция не
-- трогает — двойник разбирается отдельно.
--
-- Проба 636: у «Водопада Спокойного» снимков нет.
--
-- «Адаптировать»: карточка места показывает снимки в рамке во всю ширину и
-- высотой 62% экрана — на телефоне это почти 3:4. Полоса 16:9 в такой рамке
-- обрезается до центральных 40% ширины, и человек на краю кадра пропадает.
-- Поэтому кадры здесь вертикальные, 3:4, 960x1280, JPEG q80: на телефоне —
-- целиком, на широком экране — средняя полоса.
--
-- Разрешение на публикацию снимков Алины подтверждено 30.09; `license` не
-- ставится. На обоих кадрах галереи — сама Алина.
--
-- IDEMPOTENT

BEGIN;

-- ── 1. Герой ──────────────────────────────────────────────────────────────
-- Встаёт только поверх снимка без ручного происхождения: чужой ручной снимок
-- и снимок с Викисклада не перетираются (тот же предикат, что в 1115).
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок Алины Гусаковой: водопад Спокойный (Снежный Барс) (миграция 1128)',
       'manual-upload',
       960,
       1280,
       'Алина Гусакова',
       'migrations/photos/6bbf443b3c37eb6bc3384abcaa956fbc7f88c85ab404b34ea3248e9a1547bbea.jpg'
  FROM places p
 WHERE p.id::text = 'a532f015-d208-48d7-8a26-01345a0e1edc'
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
       960,
       1280,
       'Алина Гусакова в брызгах водопада',
       'Алина Гусакова',
       'migrations/photos/ca3900c317bfc6ed45b199ec16372e6aa81d759e78cac8cfe278cd5f9530d512.jpg'
  FROM places p
 WHERE p.id::text = 'a532f015-d208-48d7-8a26-01345a0e1edc'
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
       960,
       1280,
       'Алина Гусакова у водопада',
       'Алина Гусакова',
       'migrations/photos/0f81e4318dd6cbf310bbcb1e6defbeeed0e2d6dc65dd1ed401f8663bcaf01d2f.jpg'
  FROM places p
 WHERE p.id::text = 'a532f015-d208-48d7-8a26-01345a0e1edc'
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
   WHERE id::text = 'a532f015-d208-48d7-8a26-01345a0e1edc' AND is_visible AND merged_into_id IS NULL;

  IF v_ark IS NULL THEN
    RAISE WARNING '[1128] живой записи «Водопад Спокойный» нет — снимки не легли';
    RETURN;
  END IF;

  SELECT author INTO v_author FROM ai_route_images WHERE route_id = v_ark;
  IF v_author IS DISTINCT FROM 'Алина Гусакова' THEN
    RAISE WARNING '[1128] герой «Водопад Спокойный» НЕ встал: там %', COALESCE('автор «' || v_author || '»', 'строки снимка нет');
  END IF;

  SELECT count(*) INTO v_count FROM place_gallery_photos
   WHERE ark_id = v_ark AND author = 'Алина Гусакова' AND position BETWEEN 1 AND 2;
  IF v_count <> 2 THEN
    RAISE WARNING '[1128] галерея «Водопад Спокойный»: легло % кадров из 2 (позиции заняты чужими подписями?)', v_count;
  END IF;
END $$;

COMMIT;
