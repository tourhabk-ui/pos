-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1126: «Дачные горячие источники» — четыре кадра Алины Гусаковой в галерею.
--
-- Та же серия, что в 1125 («Мутновская ГеоТЕЦ», автор Алина Гусакова). Сюда —
-- термальное поле: грязевой котёл, парящая долина со снежником, Алина у
-- парящих выходов, долина с ручьём под снежниками.
--
-- Куда: живая запись «Дачные горячие источники» (2bf92082) — проба 631;
-- проба 632: героем стоит снимок владельца платформы, галереи нет. Героя эта
-- миграция НЕ трогает — только галерея, позиции 1–4.
--
-- На портрете Алины вдали — другие туристы: мелкие фигуры, лиц не
-- различить. Название группы источников на кадрах не утверждается.
--
-- Обрезка 16:9: снимки шире 1280 — до 1280x720, остальные 960x540; JPEG q82.
-- Байты увезёт cron-images-to-s3 (§4.1).
--
-- IDEMPOTENT

BEGIN;

-- ── 2.1. Галерея, позиция 1 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       1,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Грязевой котёл, жёлтые отложения по краю',
       'Алина Гусакова',
       'migrations/photos/ca6833a858a6a7d12fa3e6649208b3bd499c49410f21d54fbb6074b685992e45.jpg'
  FROM places p
 WHERE p.id::text = '2bf92082-0daf-4770-8031-a51c0f355be8'
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
       540,
       'Парящая долина под снежником',
       'Алина Гусакова',
       'migrations/photos/0881a996c9a04254a9508528e8e4245abf8996b1de38f7471d11e58e9a69ca21.jpg'
  FROM places p
 WHERE p.id::text = '2bf92082-0daf-4770-8031-a51c0f355be8'
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

-- ── 2.3. Галерея, позиция 3 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       3,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Алина Гусакова у парящих выходов',
       'Алина Гусакова',
       'migrations/photos/da81ff7670789c7a2e64fe5f05e5326322d293e570813bb7afefa71088059f60.jpg'
  FROM places p
 WHERE p.id::text = '2bf92082-0daf-4770-8031-a51c0f355be8'
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

-- ── 2.4. Галерея, позиция 4 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       4,
       NULL::bytea,
       'image/jpeg',
       960,
       540,
       'Долина с ручьём под снежниками',
       'Алина Гусакова',
       'migrations/photos/961286aa3242f6520284b851e88845f0e958b507d18e5a262ff4d5ac0fcfd60f.jpg'
  FROM places p
 WHERE p.id::text = '2bf92082-0daf-4770-8031-a51c0f355be8'
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
   WHERE id::text = '2bf92082-0daf-4770-8031-a51c0f355be8' AND is_visible AND merged_into_id IS NULL;

  IF v_ark IS NULL THEN
    RAISE WARNING '[1126] живой записи «Дачные горячие источники» нет — снимки не легли';
    RETURN;
  END IF;

  SELECT count(*) INTO v_count FROM place_gallery_photos
   WHERE ark_id = v_ark AND author = 'Алина Гусакова' AND position BETWEEN 1 AND 4;
  IF v_count <> 4 THEN
    RAISE WARNING '[1126] галерея «Дачные горячие источники»: легло % кадров из 4 (позиции заняты чужими подписями?)', v_count;
  END IF;
END $$;

COMMIT;
