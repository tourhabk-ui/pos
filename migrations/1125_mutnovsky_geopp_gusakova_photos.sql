-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1125: «Мутновская ГеоЭС» — герой и кадр Алины Гусаковой.
--
-- Владелец 30.09 прислал шесть кадров со словами «Мутновская ГеоТЕЦ», автор —
-- Алина Гусакова (разрешение на публикацию её снимков подтверждено 30.09,
-- 1115, 1119–1122; `license` не ставится). На предложение разделить серию —
-- «раздели как предложил»: на ГеоЭС два кадра, где видна станция и её
-- скважина; четыре кадра термального поля — на «Дачные горячие источники»
-- (1126).
--
-- Куда: живая запись «Мутновская ГеоЭС» (84f12e37) — проба 631; проба 632:
-- снимков у места нет.
--
-- Герой — бревенчатый мостик через ручей, за ним пар и постройки станции.
-- Галерея — Алина у старого оголовка скважины. Что это за скважина и
-- действует ли она, по снимку не утверждаю: подпись называет то, что видно.
--
-- Обрезка 16:9 во всю ширину, 960x540, JPEG q82. Байты увезёт
-- cron-images-to-s3 (§4.1).
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
       'снимок Алины Гусаковой: мостик через ручей у Мутновской ГеоЭС (миграция 1125)',
       'manual-upload',
       960,
       540,
       'Алина Гусакова',
       'migrations/photos/6f00f8643f72eeda1bd562d45ed7510eca53120442fb40730d10869d8b19f30e.jpg'
  FROM places p
 WHERE p.id::text = '84f12e37-fd15-44e7-b60e-063f176d059e'
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
       'Алина Гусакова у старого оголовка скважины',
       'Алина Гусакова',
       'migrations/photos/03a5dec01ee8990a3a7e3199b560634325b81762e54e188dcbfdb27701980484.jpg'
  FROM places p
 WHERE p.id::text = '84f12e37-fd15-44e7-b60e-063f176d059e'
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
   WHERE id::text = '84f12e37-fd15-44e7-b60e-063f176d059e' AND is_visible AND merged_into_id IS NULL;

  IF v_ark IS NULL THEN
    RAISE WARNING '[1125] живой записи «Мутновская ГеоЭС» нет — снимки не легли';
    RETURN;
  END IF;

  SELECT author INTO v_author FROM ai_route_images WHERE route_id = v_ark;
  IF v_author IS DISTINCT FROM 'Алина Гусакова' THEN
    RAISE WARNING '[1125] герой «Мутновская ГеоЭС» НЕ встал: там %', COALESCE('автор «' || v_author || '»', 'строки снимка нет');
  END IF;

  SELECT count(*) INTO v_count FROM place_gallery_photos
   WHERE ark_id = v_ark AND author = 'Алина Гусакова' AND position BETWEEN 1 AND 1;
  IF v_count <> 1 THEN
    RAISE WARNING '[1125] галерея «Мутновская ГеоЭС»: легло % кадров из 1 (позиции заняты чужими подписями?)', v_count;
  END IF;
END $$;

COMMIT;
