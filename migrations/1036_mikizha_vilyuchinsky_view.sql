-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1036: «Озеро Микижа» — снимок владельца «Вид на Вилючинский вулкан с
-- озера Микижа» (27.09), третьим кадром галереи.
--
-- Та же запись и тот же отбор, что в 1033: имя «Озеро Микижа» и координата
-- 53.01045/158.26904 с допуском ~100 м, среди неслитых; совпало не ровно
-- одно — не пишется ничего, и это говорится вслух.
--
-- Обрезка: исходник 3000x4000 (портрет). Окно 16:9 полной ширины со
-- смещением 30% сверху — вершина с облаком у склона и кромка осеннего леса.
-- Гладь озера в то же окно с вершиной не помещается (между ними ~60% высоты
-- кадра), а суть снимка — вид на вулкан. Сжато до 1280x720, JPEG q80.
--
-- Галерея: позиция 3, не поверх чужого кадра — перезаписывается только
-- строка с НАШЕЙ подписью (тот же приём, что в 1033). Байты пишутся в базу:
-- миграция идёт при старте сервера; увезёт уборщик cron-images-to-s3 (§4.1).
--
-- Права: снимок прислал владелец платформы, лицензия не ставится.
--
-- IDEMPOTENT

BEGIN;

WITH target AS (
  SELECT p.ark_id
    FROM places p
   WHERE p.name = 'Озеро Микижа'
     AND p.merged_into_id IS NULL
     AND p.ark_id IS NOT NULL
     AND abs(p.lat::float8 - 53.01045) < 0.001
     AND abs(p.lng::float8 - 158.26904) < 0.001
)
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT t.ark_id,
       3,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Озеро Микижа: вид на Вилючинский вулкан',
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
  v_c3  text;
BEGIN
  SELECT count(*), min(p.ark_id::text)::uuid INTO v_n, v_ark
    FROM places p
   WHERE p.name = 'Озеро Микижа'
     AND p.merged_into_id IS NULL
     AND p.ark_id IS NOT NULL
     AND abs(p.lat::float8 - 53.01045) < 0.001
     AND abs(p.lng::float8 - 158.26904) < 0.001;

  IF v_n <> 1 THEN
    RAISE WARNING '[1036] «Озеро Микижа» у 53.01045/158.26904 найдено % раз вместо одного — снимок НЕ лёг', v_n;
    RETURN;
  END IF;

  SELECT caption INTO v_c3 FROM place_gallery_photos WHERE ark_id = v_ark AND position = 3;
  IF v_c3 IS DISTINCT FROM 'Озеро Микижа: вид на Вилючинский вулкан' THEN
    RAISE WARNING '[1036] галерея озера Микижа: позиция 3 занята чужим кадром (%) — наш не лёг', COALESCE(v_c3, 'пусто');
  END IF;
END $$;

COMMIT;
