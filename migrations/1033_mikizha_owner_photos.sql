-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1033: «Озеро Микижа» — снимки владельца: герой и два кадра в галерею.
--
-- ── Что за кадры ──────────────────────────────────────────────────────────
--
-- 26.09 владелец прислал пять снимков с подписью «Озеро Микижа». Три — само
-- озеро: причал с катамаранами и лодкой на фоне сопок (герой), гладь с
-- берёзовым берегом и сопками (галерея, 1), галечный спуск к воде сквозь
-- деревья (галерея, 2). Два оставшихся — термальный бассейн базы отдыха на
-- берегу. На карточку МЕСТА они не идут: бассейн — не свойство озера, а
-- услуга базы, коммерция живёт на карточке жилья (CLAUDE.md §9).
--
-- ── Какая запись ──────────────────────────────────────────────────────────
--
-- id записи из контейнера разработки не узнать: база прода закрыта. Запись
-- опознана по ответу MCP get_place_info того же дня — «Озеро Микижа [lake]»,
-- 53.01045/158.26904. Отбор держит ОБА признака: имя и координату с допуском
-- ~100 м, среди неслитых. Совпало не ровно одно — не пишется ничего, и это
-- говорится вслух (урок Авачинского, 981: одноимённых записей бывает две, и
-- снимок на скрытой не виден никому).
--
-- ── Обрезка ───────────────────────────────────────────────────────────────
--
-- Исходники 4000x3000. Окно 16:9 полной ширины, смещения сверху: герой 30%
-- (сопки целиком, причал не срезан), гладь 12% (линия берега и сопки в
-- верхней трети), спуск 40% (галька и вода). Сжато до 1280x720, JPEG q80.
--
-- ── Как ложится ───────────────────────────────────────────────────────────
--
-- Герой: ON CONFLICT (route_id) DO UPDATE — но НЕ поверх чужого ручного
-- снимка (wikimedia, manual-upload), кроме повтора этой же миграции.
-- Галерея: позиции 1 и 2, и тоже не поверх чужого кадра — перезаписывается
-- только строка с НАШЕЙ подписью. Прежняя форма (985) переписывала позицию
-- безусловно и могла бы молча стереть чужой снимок галереи.
--
-- Байты пишутся в базу: миграция идёт при старте сервера, сетевой вызов
-- стопорил бы накат. Увезёт уборщик cron-images-to-s3 (§4.1).
--
-- Права: снимки прислал владелец платформы, лицензия не ставится.
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
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT t.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: озеро Микижа, причал (миграция 1033)',
       'manual-upload',
       1280,
       720,
       'владелец платформы',
       'migrations/photos/f2c008d45cb331f5236be1944992e571f63f8e821616d0f63951605f1178488c.jpg'
  FROM target t
 WHERE (SELECT count(*) FROM target) = 1
ON CONFLICT (route_id) DO UPDATE
   SET image_data = EXCLUDED.image_data,
       mime_type  = EXCLUDED.mime_type,
       prompt     = EXCLUDED.prompt,
       model      = EXCLUDED.model,
       width      = EXCLUDED.width,
       height     = EXCLUDED.height,
       author     = EXCLUDED.author,
       s3_url     = NULL,
       s3_key     = EXCLUDED.s3_key,
       created_at = NOW()
 WHERE ai_route_images.model NOT IN ('wikimedia', 'manual-upload')
    OR ai_route_images.prompt = 'снимок владельца: озеро Микижа, причал (миграция 1033)';

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
       1,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Озеро Микижа: гладь, берёзовый берег и сопки',
       'владелец платформы',
       'migrations/photos/7d7ffec42b993e5958aba62e6f96d157c2c912058cb61a548d7122ecd13adab5.jpg'
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
       2,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Озеро Микижа: галечный спуск к воде',
       'владелец платформы',
       'migrations/photos/b8192a6a93b8f7c4c88d7b0251340456ea93f72f562b33966d05f0aa0ba5b04b.jpg'
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
  v_n      int;
  v_ark    uuid;
  v_prompt text;
  v_c1     text;
  v_c2     text;
BEGIN
  SELECT count(*), min(p.ark_id::text)::uuid INTO v_n, v_ark
    FROM places p
   WHERE p.name = 'Озеро Микижа'
     AND p.merged_into_id IS NULL
     AND p.ark_id IS NOT NULL
     AND abs(p.lat::float8 - 53.01045) < 0.001
     AND abs(p.lng::float8 - 158.26904) < 0.001;

  IF v_n <> 1 THEN
    RAISE WARNING '[1033] «Озеро Микижа» у 53.01045/158.26904 найдено % раз вместо одного — снимки НЕ легли', v_n;
    RETURN;
  END IF;

  SELECT prompt INTO v_prompt FROM ai_route_images WHERE route_id = v_ark;
  IF v_prompt IS DISTINCT FROM 'снимок владельца: озеро Микижа, причал (миграция 1033)' THEN
    RAISE WARNING '[1033] герой озера Микижа НЕ стал снимком владельца: строку держит другой ручной снимок (prompt=%)', COALESCE(v_prompt, 'строки нет');
  END IF;

  SELECT caption INTO v_c1 FROM place_gallery_photos WHERE ark_id = v_ark AND position = 1;
  SELECT caption INTO v_c2 FROM place_gallery_photos WHERE ark_id = v_ark AND position = 2;
  IF v_c1 IS DISTINCT FROM 'Озеро Микижа: гладь, берёзовый берег и сопки' OR v_c2 IS DISTINCT FROM 'Озеро Микижа: галечный спуск к воде' THEN
    RAISE WARNING '[1033] галерея озера Микижа: позиции 1/2 заняты чужими кадрами (%, %) — наши не легли', COALESCE(v_c1, 'пусто'), COALESCE(v_c2, 'пусто');
  END IF;
END $$;

COMMIT;
