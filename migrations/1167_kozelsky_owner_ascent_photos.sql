-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1167: Козельский — шесть кадров владельца с подъёма в галерею места
-- Created: 2026-10-04
--
-- Владелец 04.10 прислал 17 своих снимков с Козельского вулкана: «наверное
-- в маршруты их лучше поставить, но реши сам». Решение — в галерею МЕСТА:
-- с миграции 1163 место «Козельский» — путевая точка маршрута «Вулкан
-- Козельский», а карточка маршрута берёт снимки своих путевых точек
-- (lib/routes/waypoint-photos.ts, и героя, и галерею). Один кадр в одном
-- месте виден на обеих карточках; своей таблицы снимков у маршрута нет.
--
-- Из 17 взяты шесть: дорога к конусу, тень автора в кольце гало на
-- облаках, склон над облаками, вершинный гребень, каменные туры в тумане,
-- тень автора и гало на склоне. Тень и гало — слова владельца («это моя
-- тень и эффект гало»), подпись их и называет. Не взяты: кадр у креста с
-- другим человеком (чужие персональные данные), размытый крупный план
-- кратера и почти одинаковые кадры дороги в тумане. Карточка маршрута
-- показывает до восьми снимков (WAYPOINT_PHOTOS_LIMIT): герой + позиции
-- 1-2 (1116, 1162) + 3-7 на экране, позиция 8 — только на карточке места.
--
-- Исходники 4032x3024, повёрнуты по EXIF, это уже 3:4. Галерея 810x1080,
-- JPEG q72, без EXIF (с ним ушли бы координаты съёмки и данные телефона).
-- Автор «владелец платформы» — как у его прежних кадров (1116), лицензия
-- не ставится: снимки собственные (правило 978).
--
-- Каждый кадр встаёт только на пустую позицию или поверх самого себя (та
-- же подпись); чужой кадр на позиции не перезаписывается. Исход называется
-- вслух блоком в конце.
--
-- IDEMPOTENT

BEGIN;

-- ── Позиция 3: Дорога к конусу Козельского, над вершиной облака ──
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       3,
       NULL::bytea,
       'image/jpeg',
       810,
       1080,
       'Дорога к конусу Козельского, над вершиной облака',
       'владелец платформы',
       'migrations/photos/6b980fed70f7767865914f7f265c7f948962cef2309eb36f23ec944ebaf56611.jpg'
  FROM places p
 WHERE p.id::text = '7190e0a4-52f1-47fb-ba17-0fcb493d99df'
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

-- ── Позиция 4: Тень автора в кольце гало на облаках под склоном ──
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       4,
       NULL::bytea,
       'image/jpeg',
       810,
       1080,
       'Тень автора в кольце гало на облаках под склоном',
       'владелец платформы',
       'migrations/photos/0d9c0ba8d1827171ef681a27bc99aef4e8477b098a3e7468de934f74a6b200b5.jpg'
  FROM places p
 WHERE p.id::text = '7190e0a4-52f1-47fb-ba17-0fcb493d99df'
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

-- ── Позиция 5: Склон Козельского над облаками ──
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       5,
       NULL::bytea,
       'image/jpeg',
       810,
       1080,
       'Склон Козельского над облаками',
       'владелец платформы',
       'migrations/photos/8c6d220c9b83c53df3178ec038010343561c784b028b38e03d410be892c31781.jpg'
  FROM places p
 WHERE p.id::text = '7190e0a4-52f1-47fb-ba17-0fcb493d99df'
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

-- ── Позиция 6: Вершинный гребень в ясный день ──
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       6,
       NULL::bytea,
       'image/jpeg',
       810,
       1080,
       'Вершинный гребень в ясный день',
       'владелец платформы',
       'migrations/photos/4ede2a9a2f423007e57c54dd7772e36610f2ccd7072a3b5abc037aed5f9a2d32.jpg'
  FROM places p
 WHERE p.id::text = '7190e0a4-52f1-47fb-ba17-0fcb493d99df'
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

-- ── Позиция 7: Каменные туры на склоне в тумане ──
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       7,
       NULL::bytea,
       'image/jpeg',
       810,
       1080,
       'Каменные туры на склоне в тумане',
       'владелец платформы',
       'migrations/photos/b1529f730ca8ab832a6ca8eb12d67e58cd139c73906abda67be910a2ffa985a2.jpg'
  FROM places p
 WHERE p.id::text = '7190e0a4-52f1-47fb-ba17-0fcb493d99df'
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

-- ── Позиция 8: Тень автора на склоне и гало в тумане ──
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       8,
       NULL::bytea,
       'image/jpeg',
       810,
       1080,
       'Тень автора на склоне и гало в тумане',
       'владелец платформы',
       'migrations/photos/9368cc71d33418d9d31a9c5a3538d50a217f7e2be8a70d9f66fa5d5801a1cdba.jpg'
  FROM places p
 WHERE p.id::text = '7190e0a4-52f1-47fb-ba17-0fcb493d99df'
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
  v_ark  uuid;
  v_caps text[] := ARRAY['Дорога к конусу Козельского, над вершиной облака', 'Тень автора в кольце гало на облаках под склоном', 'Склон Козельского над облаками', 'Вершинный гребень в ясный день', 'Каменные туры на склоне в тумане', 'Тень автора на склоне и гало в тумане'];
  v_cap  text;
  i      int;
BEGIN
  SELECT ark_id INTO v_ark FROM places
   WHERE id::text = '7190e0a4-52f1-47fb-ba17-0fcb493d99df' AND is_visible AND merged_into_id IS NULL;

  IF v_ark IS NULL THEN
    RAISE WARNING '[1167] живой записи «Козельский» нет — кадры не легли';
    RETURN;
  END IF;

  FOR i IN 1..6 LOOP
    SELECT caption INTO v_cap FROM place_gallery_photos WHERE ark_id = v_ark AND position = i + 2;
    IF v_cap IS DISTINCT FROM v_caps[i] THEN
      RAISE WARNING '[1167] позиция % у «Козельского» занята другим кадром: %', i + 2, COALESCE('«' || v_cap || '»', 'строки нет');
    END IF;
  END LOOP;
END $$;

COMMIT;
