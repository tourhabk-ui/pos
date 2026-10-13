-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1008: «Малкинские горячие источники» — два кадра владельца: герой и галерея.
--
-- ── Что прислано ──────────────────────────────────────────────────────────
--
-- 24.09 владелец прислал три кадра одной подписью: «Малкинские горячие
-- источники». Сумерки, пар над водой, люди у купелей. Публикуются два,
-- третий — размытый дубль второго (снят с движения) и не берётся.
--
-- ── Куда ──────────────────────────────────────────────────────────────────
--
-- Проба 565 (place-audit): записей две, живая одна.
--
--   284c862f  «Малкинские горячие источники»    видимая, не слитая  ← сюда
--   9fb0ba03  «Малкинские термальные источники» СЛИТА в 284c862f (173)
--
-- Координата записи 53.322/157.539 — это и есть источники у посёлка Малки.
--
-- ── Люди в кадре ──────────────────────────────────────────────────────────
--
-- Это общественная купальня, и людей на ней столько же, сколько пара. На
-- герое — полтора десятка фигур в сумерках, все на расстоянии, лиц не
-- разобрать ни на одной: силуэты, а не портреты. В галерейном кадре двое в
-- купели — две головы над водой в тридцать пикселей. Правило прежнее (967,
-- 1002, 1007): не публикуется тот, кого можно узнать; здесь узнать некого.
-- Тот же довод, каким в 1002 оставлена «дальняя фигура в глубине кадра».
--
-- ── Автор ─────────────────────────────────────────────────────────────────
--
-- НЕ ЗАПИСАН: владелец прислал только имя места. author = NULL — «не знаю»,
-- а не «ничей» (§4.0). Назовёт — впишется отдельной миграцией.
-- Следствие для ON CONFLICT: неподписанный кадр не вытесняет подписанный,
-- только машинный, неподписанный или свой прежний (правило 1001).
--
-- ── Обрезка ───────────────────────────────────────────────────────────────
--
-- Исходники вертикальные, 3024x4032 после поворота по EXIF. Окно 16:9
-- полной ширины (3024x1701), уменьшено до 1280x720. Смещение сверху по
-- предмету: 1250 у героя (пар и купели посередине, небо срезано), 1000 у
-- купели. Содержимое не менялось.
--
-- ── Как ложится ───────────────────────────────────────────────────────────
--
-- Герой — ai_route_images (ON CONFLICT (route_id)), галерея —
-- place_gallery_photos (968), позиция 1. Байты в базе, ночной
-- cron-images-to-s3 увезёт (правило 18.09); s3_url/s3_key обнуляются.
--
-- IDEMPOTENT

BEGIN;

-- ── Герой ─────────────────────────────────────────────────────────────────
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: Малкинские горячие источники, пар над купелями в сумерках (миграция 1008)',
       'manual-upload',
       1280,
       720,
       NULL,
       'migrations/photos/ea4ac97f140b46e3af8b87b6e518394eb24e1d089a57dddeba0fd8d1f37139f4.jpg'
  FROM places p
 WHERE p.id::text = '284c862f-a339-409d-988a-da4107324b60'
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
       s3_url     = NULL,
       s3_key     = EXCLUDED.s3_key,
       created_at = NOW()
 WHERE ai_route_images.model NOT IN ('wikimedia', 'manual-upload')
    OR ai_route_images.author IS NULL
    OR ai_route_images.prompt = 'снимок владельца: Малкинские горячие источники, пар над купелями в сумерках (миграция 1008)';

-- ── Галерея 1: Купель у реки, лагерь на дальнем берегу ──
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       1,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Купель у реки, лагерь на дальнем берегу',
       NULL,
       'migrations/photos/930be7f249affa0fb02ce26ba2567449655ff61932fd462c5fafb629488c9fad.jpg'
  FROM places p
 WHERE p.id::text = '284c862f-a339-409d-988a-da4107324b60'
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
       created_at = NOW();

-- ── Отказ называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_ark     uuid;
  v_visible boolean;
  v_merged  uuid;
  v_prompt  text;
  v_gallery int;
BEGIN
  SELECT ark_id, is_visible, merged_into_id INTO v_ark, v_visible, v_merged
    FROM places WHERE id::text = '284c862f-a339-409d-988a-da4107324b60';

  IF v_ark IS NULL THEN
    RAISE WARNING '[1008] записи «Малкинские горячие источники» (284c862f-a339-409d-988a-da4107324b60) нет или у неё нет ark_id — снимки вешать некуда';
    RETURN;
  END IF;

  IF v_visible IS DISTINCT FROM true OR v_merged IS NOT NULL THEN
    RAISE WARNING '[1008] «Малкинские горячие источники» скрыта или слита — снимки легли туда, где карточка их не покажет';
  END IF;

  SELECT prompt INTO v_prompt FROM ai_route_images WHERE route_id = v_ark;
  IF v_prompt IS DISTINCT FROM 'снимок владельца: Малкинские горячие источники, пар над купелями в сумерках (миграция 1008)' THEN
    RAISE WARNING '[1008] герой «Малкинские горячие источники» НЕ заменён: на месте остался подписанный снимок (%)', v_prompt;
  END IF;

  SELECT COUNT(*) INTO v_gallery FROM place_gallery_photos WHERE ark_id = v_ark AND position = 1;
  IF v_gallery <> 1 THEN
    RAISE WARNING '[1008] галерейный кадр «Малкинские горячие источники» не лёг';
  END IF;
END $$;

COMMIT;
