-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1120: «Вачкажец» — герой и девять кадров Алины Гусаковой.
--
-- Владелец 30.09 прислал одиннадцать кадров со словами «Горный массив
-- Вачкажец»; автор всей серии — Алина Гусакова (владелец, дословно: «это
-- серия фотографий вся от Алины Гусаковой»), разрешение на публикацию её
-- снимков подтверждено 30.09 (как в 1115 и 1119). `license` не ставится:
-- разрешение на публикацию — не лицензия.
--
-- ── Куда ──────────────────────────────────────────────────────────────────
--
-- Живая запись места «Вачкажец» (c4310d06, mountain) — проба 629. Проба 630:
-- у места один герой без подписи автора, галереи нет. Нового места не
-- заводится.
--
-- ── Что из серии взято ────────────────────────────────────────────────────
--
-- Девять кадров из одиннадцати: не взяты крупный план воды (второй такой же
-- сюжет, как вода у края каньона) и второй вид того же каньона сверху.
-- На кадре 2 галереи — сама Алина, на кадре 8 — её пёс Грей (так их назвал
-- владелец). Люди на герое — фигуры вдалеке на тропе, лиц не видно.
--
-- Подписи — только то, что видно. Озеро на седьмом кадре НЕ названо: рядом
-- с массивом по справочнику есть «Озеро Тахколоч», но по снимку я этого
-- не утверждаю. Каньон с водой тоже без имени: к какому водопаду он
-- относится, по кадру не видно.
--
-- Обрезка 16:9 полосой во всю ширину со смещением под сюжет: снимки шире
-- 1280 — до 1280x720, остальные 960x540; JPEG q82.
-- Байты увезёт уборщик cron-images-to-s3 (§4.1).
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
       'снимок Алины Гусаковой: цирк массива Вачкажец со снежниками (миграция 1120)',
       'manual-upload',
       960,
       540,
       'Алина Гусакова',
       'migrations/photos/261b1dfc1dec9a186a59b690a707fb6df5986dace3f0843578e38b80276c59bc.jpg'
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
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
       540,
       'Цирк Вачкажца под облаками, снежники на осыпях',
       'Алина Гусакова',
       'migrations/photos/e517d250d4aacf85a4796e76b31bd42565fce81c0bdaff4a48f1fa6465e4cf50.jpg'
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
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
       1280,
       720,
       'Алина Гусакова у перил под вершинами Вачкажца',
       'Алина Гусакова',
       'migrations/photos/77240a9563f9a9b5d99bf5be5a05626109de83c6c42ac96327144aeba40ac813.jpg'
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
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
       'Осенний кустарник под склонами Вачкажца',
       'Алина Гусакова',
       'migrations/photos/7822bc643babadcf3853c92d1ca7068558e6bccee278edd6404a7112b1101ee4.jpg'
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
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
       1280,
       720,
       'Скальный гребень Вачкажца в облаке',
       'Алина Гусакова',
       'migrations/photos/984d48b30b47fec4846194fbd56b77e11757f8d2a131fd94a6dc55ab76fe2858.jpg'
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
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
       'Ручей в узком каньоне',
       'Алина Гусакова',
       'migrations/photos/69c946777a7ec42d8104bb026c300b687d66c0d65628bff0d52c05fc4c1893be.jpg'
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
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
       960,
       540,
       'Вода уходит через край в каньон',
       'Алина Гусакова',
       'migrations/photos/657da9873eb410c8d5c947920efd6fd8ef64685ab4182bdb865f1fbe51e857b2.jpg'
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
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

-- ── 2.7. Галерея, позиция 7 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       7,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Озеро в долине у подножия массива',
       'Алина Гусакова',
       'migrations/photos/ad58bbb3e9e2cd062d925da331696cab80ca85ff0d08b30c7585c4ecd49c4ce9.jpg'
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
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

-- ── 2.8. Галерея, позиция 8 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       8,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Пёс Грей у ручья под снежником',
       'Алина Гусакова',
       'migrations/photos/25e73f92e3702f09c72963215be92dd63d3d4d0ada00745c045c15aced658cab.jpg'
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
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

-- ── 2.9. Галерея, позиция 9 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       9,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Трещина в снежнике',
       'Алина Гусакова',
       'migrations/photos/f235e073cfb248ed778fc9d732e95fdb3ed5ebade2459d371a77286bde1eee0b.jpg'
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
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
   WHERE id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe' AND is_visible AND merged_into_id IS NULL;

  IF v_ark IS NULL THEN
    RAISE WARNING '[1120] живой записи «Вачкажец» нет — снимки не легли';
    RETURN;
  END IF;

  SELECT author INTO v_author FROM ai_route_images WHERE route_id = v_ark;
  IF v_author IS DISTINCT FROM 'Алина Гусакова' THEN
    RAISE WARNING '[1120] герой «Вачкажец» НЕ встал: там %', COALESCE('автор «' || v_author || '»', 'строки снимка нет');
  END IF;

  SELECT count(*) INTO v_count FROM place_gallery_photos
   WHERE ark_id = v_ark AND author = 'Алина Гусакова' AND position BETWEEN 1 AND 9;
  IF v_count <> 9 THEN
    RAISE WARNING '[1120] галерея «Вачкажец»: легло % кадров из 9 (позиции заняты чужими подписями?)', v_count;
  END IF;
END $$;

COMMIT;
