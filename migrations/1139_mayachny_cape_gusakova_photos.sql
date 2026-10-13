-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1139: «Мыс Маячный» — шесть кадров Алины Гусаковой в галерею.
--
-- Владелец 02.10 прислал шесть кадров с подписью «Мыс Маячный, автор Алина
-- Гусакова» и попросил адаптировать и сжать «по образцу» — то есть как в
-- 1129–1134: вертикальный 3:4, JPEG q72. Автор — Алина Гусакова, как и во всей
-- её серии (1115–1134); `license` не ставится: разрешение на публикацию —
-- не лицензия, и приписывать снимку строку, которую никто не называл, нельзя.
--
-- ── Куда ──────────────────────────────────────────────────────────────────
--
-- Запись «Мыс Маячный» (3268583a, cape) — та, на которую владелец называет
-- кадры. Маяк живёт отдельной записью (0aa97c3c, «Маяк Петропавловский»,
-- миграции 976/977); его карточку эта миграция НЕ трогает: сопоставление
-- «башня на карточке маяка» — решение владельца, а не моё.
--
-- Героя эта миграция НЕ трогает: на мысе стоит ручной снимок владельца
-- (962), и чужой настоящий снимок не вытесняется. Кадры идут в галерею,
-- позиции 1–6. Если у владельца есть желание поставить героем кадр Алины —
-- это отдельное слово.
--
-- ── Что в кадрах ──────────────────────────────────────────────────────────
--
-- 1 маяк на склоне, горит огонь, постройки поста; 2 башня крупно, на
-- горизонте заснеженные горы; 3 маяк над бухтой; 4 обрыв и чёрный песчаный
-- пляж; 5 чайки на скалах над океаном; 6 прибой у подножия обрыва. На
-- кадре 1 виден пост (антенны, строения, цистерны) — тот же, что в кадрах
-- владельца из 977; на кадрах 2 и 3 рядом с башней только белая будка.
-- Людей в кадре нет. Подписи — только то, что видно:
-- без названий бухт и скал, которых по снимку не утвердить.
--
-- Исходники ~963x1279 уже вертикальные 3:4; кадр берётся целиком, 720x960
-- (как галерея в 1129–1134). Строка с позицией, занятой чужим снимком (автор
-- не «Алина Гусакова»), не перезаписывается. s3_url сбрасывается — байты
-- увезёт cron-images-to-s3 (§4.1).
--
-- IDEMPOTENT

BEGIN;

-- ── Галерея, позиция 1 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       1,
       NULL::bytea,
       'image/jpeg',
       720,
       960,
       'Маяк на склоне вечером, горит огонь',
       'Алина Гусакова',
       'migrations/photos/4d1518ce28c5e5f9c4d8120b23dc908f992f14a186349b2496c4ba42c8115ae2.jpg'
  FROM places p
 WHERE p.id::text = '3268583a-05e0-4f59-8d2c-a87a69be14a6'
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
 WHERE place_gallery_photos.author = 'Алина Гусакова';

-- ── Галерея, позиция 2 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       2,
       NULL::bytea,
       'image/jpeg',
       720,
       960,
       'Башня маяка крупно, на горизонте горы',
       'Алина Гусакова',
       'migrations/photos/95783b8c28db73360aeceb65cf14f18160833abbc775615980c994245908d86b.jpg'
  FROM places p
 WHERE p.id::text = '3268583a-05e0-4f59-8d2c-a87a69be14a6'
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
 WHERE place_gallery_photos.author = 'Алина Гусакова';

-- ── Галерея, позиция 3 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       3,
       NULL::bytea,
       'image/jpeg',
       720,
       960,
       'Маяк над бухтой, вдали скалы',
       'Алина Гусакова',
       'migrations/photos/91c4b5e2f2d278582cb6d06f2769698396d4ad4cfbd97d21c3c29a6b3dade033.jpg'
  FROM places p
 WHERE p.id::text = '3268583a-05e0-4f59-8d2c-a87a69be14a6'
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
 WHERE place_gallery_photos.author = 'Алина Гусакова';

-- ── Галерея, позиция 4 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       4,
       NULL::bytea,
       'image/jpeg',
       720,
       960,
       'Обрыв мыса и чёрный песчаный пляж',
       'Алина Гусакова',
       'migrations/photos/6319386815fc532793fcdbf5acb2c08f8f681a8e1198c4e3040c42ccb7b86e58.jpg'
  FROM places p
 WHERE p.id::text = '3268583a-05e0-4f59-8d2c-a87a69be14a6'
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
 WHERE place_gallery_photos.author = 'Алина Гусакова';

-- ── Галерея, позиция 5 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       5,
       NULL::bytea,
       'image/jpeg',
       720,
       960,
       'Чайки на скалах над океаном',
       'Алина Гусакова',
       'migrations/photos/392b70f165287548298a04a74282d9525abe330c5b19769bcf5953f175bb8102.jpg'
  FROM places p
 WHERE p.id::text = '3268583a-05e0-4f59-8d2c-a87a69be14a6'
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
 WHERE place_gallery_photos.author = 'Алина Гусакова';

-- ── Галерея, позиция 6 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       6,
       NULL::bytea,
       'image/jpeg',
       720,
       960,
       'Прибой у подножия обрыва',
       'Алина Гусакова',
       'migrations/photos/a5b1f78432591fd6c29f2541ded7273b2d389ca00b39d9c5a78acccb053bcd04.jpg'
  FROM places p
 WHERE p.id::text = '3268583a-05e0-4f59-8d2c-a87a69be14a6'
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
 WHERE place_gallery_photos.author = 'Алина Гусакова';

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n
    FROM place_gallery_photos g JOIN places p ON g.ark_id = p.ark_id
   WHERE p.id::text = '3268583a-05e0-4f59-8d2c-a87a69be14a6' AND g.author = 'Алина Гусакова'
     AND g.position BETWEEN 1 AND 6 AND g.height > g.width;
  IF v_n <> 6 THEN
    RAISE WARNING '[1139] «Мыс Маячный»: кадров Алины в 3:4 % из 6 (место не найдено, нет ark_id или позицию держит чужой снимок)', v_n;
  END IF;
END $$;

COMMIT;
