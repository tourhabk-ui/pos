-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1162: Козельский вулкан — кадр Ильи Оноприйчука в галерею
-- Created: 2026-10-04
--
-- Владелец 04.10: «Козельский вулкан. Фото Илья Оноприйчук, согласие дал на
-- публикацию. Адаптируй по правилам, фотография большая». Исходник 7360x4912
-- (18 МБ). По правилу 01.10 кадр места — 3:4: окно 3300x4400 от нижнего края,
-- по центру вершины (x 2140), — массив целиком, сверху меньше пустого неба.
-- Галерея 810x1080, JPEG q72, без EXIF (вместе с ним ушли бы координаты
-- съёмки и данные камеры автора).
--
-- Герой у Козельского — кадр владельца платформы (проба 694: photoCount 2,
-- автор «владелец платформы»), его не трогаем: кадр Ильи — позиция 2,
-- первая свободная. Имя автора в подписи «Фото:» — тем же коммитом
-- (otherAuthors в place-detail): до него авторы галереи не показывались, и
-- кадр вышел бы под именем владельца героя.
--
-- Встаёт только на пустую позицию или поверх самого себя (та же подпись).
-- Исход называется вслух блоком в конце.

BEGIN;

INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       2,
       NULL::bytea,
       'image/jpeg',
       810,
       1080,
       'Козельский вулкан в снегу, вечерний свет',
       'Илья Оноприйчук',
       'migrations/photos/6effebc17fe4ae898ce9d9d2e73bbd1896c94e016b888cb649692d876dc02f3a.jpg'
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
  v_ark    uuid;
  v_author text;
BEGIN
  SELECT ark_id INTO v_ark FROM places
   WHERE id::text = '7190e0a4-52f1-47fb-ba17-0fcb493d99df' AND is_visible AND merged_into_id IS NULL;

  IF v_ark IS NULL THEN
    RAISE WARNING '[1162] живой записи «Козельский» нет — кадр не лёг';
    RETURN;
  END IF;

  SELECT author INTO v_author FROM place_gallery_photos WHERE ark_id = v_ark AND position = 2;
  IF v_author IS DISTINCT FROM 'Илья Оноприйчук' THEN
    RAISE WARNING '[1162] позиция 2 у «Козельского» занята: %', COALESCE('автор «' || v_author || '»', 'строки нет');
  END IF;
END $$;

COMMIT;
