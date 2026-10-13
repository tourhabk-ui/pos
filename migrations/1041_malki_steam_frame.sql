-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1041: «Малкинские горячие источники» — третий кадр владельца: пар над купелью.
--
-- 24.09 владелец прислал три кадра, 1008 взяла два: третий был записан как
-- «размытый дубль второго (снят с движения)». 27.09 владелец прислал его
-- снова и поправил: «это не размытый кадр, а пар над источником». Туман над
-- купелью слева и есть то, ради чего кадр снят, — второй галерейный кадр его
-- почти не показывает. Решение о снимке — за владельцем; кадр встаёт.
--
-- Сцена та же, что у галерейного кадра 1 (купель, лагерь с костром на
-- дальнем берегу), снята дальше и шире: видна вся чаша и пар над ней.
-- Людей двое, головы над водой в пару десятков пикселей — узнать некого
-- (правило 967/1002/1008).
--
-- Обрезка: исходник вертикальный, 3024x4032 после поворота по EXIF; окно
-- 16:9 полной ширины (3024x1701) со смещением 880 сверху, 1280x720, JPEG q80.
--
-- Галерея, позиция 2 (на проде у записи занята только 1, проба 618). Чужой
-- кадр на позиции 2 не перезаписывается — только строка с НАШЕЙ подписью.
-- Байты увезёт уборщик cron-images-to-s3 (§4.1).
--
-- IDEMPOTENT

BEGIN;

WITH target AS (
  SELECT p.ark_id
    FROM places p
   WHERE p.id::text = '284c862f-a339-409d-988a-da4107324b60'
     AND p.name = 'Малкинские горячие источники'
     AND p.merged_into_id IS NULL
     AND p.ark_id IS NOT NULL
)
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT t.ark_id,
       2,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Пар над купелью в сумерках, лагерь на дальнем берегу',
       'владелец платформы',
       'migrations/photos/00e1e11d3b5ecfba8261a4ffe85f11264d75c03f4d8473e8846c9f1e686456c3.jpg'
  FROM target t
 WHERE (SELECT count(*) FROM target) = 1
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

-- ── Отказ называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_n   int;
  v_ark uuid;
  v_c2  text;
BEGIN
  SELECT count(*), min(p.ark_id::text)::uuid INTO v_n, v_ark
    FROM places p
   WHERE p.id::text = '284c862f-a339-409d-988a-da4107324b60'
     AND p.name = 'Малкинские горячие источники'
     AND p.merged_into_id IS NULL
     AND p.ark_id IS NOT NULL;

  IF v_n <> 1 THEN
    RAISE WARNING '[1041] «Малкинские горячие источники» найдено % раз вместо одного — кадр НЕ лёг', v_n;
    RETURN;
  END IF;

  SELECT caption INTO v_c2 FROM place_gallery_photos WHERE ark_id = v_ark AND position = 2;
  IF v_c2 IS DISTINCT FROM 'Пар над купелью в сумерках, лагерь на дальнем берегу' THEN
    RAISE WARNING '[1041] галерея Малкинских источников: позиция 2 занята чужим кадром (%) — наш не лёг', COALESCE(v_c2, 'пусто');
  END IF;
END $$;

COMMIT;
