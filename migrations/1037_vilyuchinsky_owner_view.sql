-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1037: «Вулкан Вилючинский» — снимок владельца «Вид на Вилючинский вулкан с
-- озера Микижа» (27.09), первым кадром галереи.
--
-- Тот же кадр, что 1036 положила в галерею озера Микижа: владелец 27.09 —
-- «да, пусть будет и на месте» (на карточке вулкана). Обрезка та же: 16:9
-- со смещением 30% сверху, 1280x720, JPEG q80.
--
-- Запись: id и имя вместе (id взят из ответа /api/places/164f612c-32da-4f0f-b261-c45c09dc2933
-- на проде, проба 611). Не совпало ровно одно среди неслитых — не пишется
-- ничего, с RAISE WARNING. Герой у вулкана уже есть (photoCount 1, проба
-- 612) и не трогается: кадр идёт в галерею, позиция 1 — галерея была пуста.
-- Чужой кадр на позиции 1 не перезаписывается, только строка с НАШЕЙ
-- подписью. Байты увезёт уборщик cron-images-to-s3 (§4.1).
--
-- Права: снимок прислал владелец платформы, лицензия не ставится.
--
-- IDEMPOTENT

BEGIN;

WITH target AS (
  SELECT p.ark_id
    FROM places p
   WHERE p.id::text = '164f612c-32da-4f0f-b261-c45c09dc2933'
     AND p.name = 'Вулкан Вилючинский'
     AND p.merged_into_id IS NULL
     AND p.ark_id IS NOT NULL
)
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT t.ark_id,
       1,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Вилючинский вулкан с озера Микижа',
       'владелец платформы',
       'migrations/photos/30494ef171e05e79c40796bb6e3ba15457ee34fffcba7723da247571aba69a06.jpg'
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
  v_c1  text;
BEGIN
  SELECT count(*), min(p.ark_id::text)::uuid INTO v_n, v_ark
    FROM places p
   WHERE p.id::text = '164f612c-32da-4f0f-b261-c45c09dc2933'
     AND p.name = 'Вулкан Вилючинский'
     AND p.merged_into_id IS NULL
     AND p.ark_id IS NOT NULL;

  IF v_n <> 1 THEN
    RAISE WARNING '[1037] «Вулкан Вилючинский» (164f612c-32da-4f0f-b261-c45c09dc2933) найдено % раз вместо одного — снимок НЕ лёг', v_n;
    RETURN;
  END IF;

  SELECT caption INTO v_c1 FROM place_gallery_photos WHERE ark_id = v_ark AND position = 1;
  IF v_c1 IS DISTINCT FROM 'Вилючинский вулкан с озера Микижа' THEN
    RAISE WARNING '[1037] галерея Вилючинского вулкана: позиция 1 занята чужим кадром (%) — наш не лёг', COALESCE(v_c1, 'пусто');
  END IF;
END $$;

COMMIT;
