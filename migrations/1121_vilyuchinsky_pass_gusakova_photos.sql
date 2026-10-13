-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1121: «Вилючинский перевал» — шесть кадров Алины Гусаковой в галерею.
--
-- Владелец 30.09: «Вилючинский перевал тоже Алина Гусакова» — шесть кадров.
-- Разрешение на публикацию снимков Алины подтверждено 30.09 (1115, 1119,
-- 1120); `license` не ставится.
--
-- ── Куда ──────────────────────────────────────────────────────────────────
--
-- Живая запись места «Вилючинский перевал» (8bad8fe6, mountain) — проба 629.
-- Проба 630: героем стоит снимок владельца платформы (подпись «владелец
-- платформы»), галереи нет. Героя эта миграция НЕ трогает — только галерея,
-- позиции 1–6.
--
-- ── Подписи ───────────────────────────────────────────────────────────────
--
-- Только то, что видно. Резные столбы названы столбами: кем и когда они
-- поставлены, по снимку не знаю. Два рассветных кадра (туман над лесом,
-- опора ЛЭП) владелец отнёс к той же серии; с какой точки они сняты, по
-- кадру не видно, поэтому в подписях нет слова «с перевала».
--
-- Обрезка 16:9 во всю ширину со смещением под сюжет: портретные — 960x540,
-- альбомные — 1280x720; JPEG q82. Байты увезёт cron-images-to-s3 (§4.1).
--
-- IDEMPOTENT

BEGIN;

-- ── 2.1. Галерея, позиция 1 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       1,
       NULL::bytea,
       'image/jpeg',
       960,
       540,
       'Вилючинский вулкан в облаке, снежники на склонах',
       'Алина Гусакова',
       'migrations/photos/db9ddea1dd8ec2e9a654078987b4ccfd32eb1a78f2c9c58e775ecfbb8fe6c9c9.jpg'
  FROM places p
 WHERE p.id::text = '8bad8fe6-c7ec-4403-b956-948706649ca8'
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
       'Резные деревянные столбы на лугу',
       'Алина Гусакова',
       'migrations/photos/a8b9f3741823e833661dfd936c8fab62c2e79a2d57587af42114e68457f92b85.jpg'
  FROM places p
 WHERE p.id::text = '8bad8fe6-c7ec-4403-b956-948706649ca8'
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
       960,
       540,
       'Кедровый стланик в каплях воды',
       'Алина Гусакова',
       'migrations/photos/f16195016b815c0119155ca02cf078368d06c33dbd018811c9a91d8783f02dd2.jpg'
  FROM places p
 WHERE p.id::text = '8bad8fe6-c7ec-4403-b956-948706649ca8'
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
       'Камень на чёрном шлаке у тропы',
       'Алина Гусакова',
       'migrations/photos/e8e7def7f599fac3cb2a5c1b4a775424425baa3782d400595b24214c088ebdb8.jpg'
  FROM places p
 WHERE p.id::text = '8bad8fe6-c7ec-4403-b956-948706649ca8'
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

-- ── 2.5. Галерея, позиция 5 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       5,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Туман над лесом на рассвете',
       'Алина Гусакова',
       'migrations/photos/e2c7051b6d2293797c9f4bee72477346e922a6db6784aeb05e026d00b0254bf8.jpg'
  FROM places p
 WHERE p.id::text = '8bad8fe6-c7ec-4403-b956-948706649ca8'
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

-- ── 2.6. Галерея, позиция 6 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       6,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Рассвет над туманом, опора ЛЭП',
       'Алина Гусакова',
       'migrations/photos/baa03f5e356f38a30c00818154562923798a2321ac39cb58f0260f82e37b0a6c.jpg'
  FROM places p
 WHERE p.id::text = '8bad8fe6-c7ec-4403-b956-948706649ca8'
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
   WHERE id::text = '8bad8fe6-c7ec-4403-b956-948706649ca8' AND is_visible AND merged_into_id IS NULL;

  IF v_ark IS NULL THEN
    RAISE WARNING '[1121] живой записи «Вилючинский перевал» нет — снимки не легли';
    RETURN;
  END IF;

  SELECT count(*) INTO v_count FROM place_gallery_photos
   WHERE ark_id = v_ark AND author = 'Алина Гусакова' AND position BETWEEN 1 AND 6;
  IF v_count <> 6 THEN
    RAISE WARNING '[1121] галерея «Вилючинский перевал»: легло % кадров из 6 (позиции заняты чужими подписями?)', v_count;
  END IF;
END $$;

COMMIT;
