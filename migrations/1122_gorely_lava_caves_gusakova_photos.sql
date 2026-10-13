-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1122: «Лавовые пещеры вулкана Горелый» — герой и два кадра Алины Гусаковой.
--
-- Владелец 30.09: «Лавовые пещеры вулкана Горелый Алина Гусакова» — три
-- кадра. Разрешение на публикацию снимков Алины подтверждено 30.09
-- (1115, 1119–1121); `license` не ставится.
--
-- Куда: живая запись места «Лавовые пещеры вулкана Горелый» (f0ecf463) —
-- сверена пробой 631 до выката. Герой встаёт только поверх снимка без
-- ручного происхождения (тот же предикат, что в 1115); чужой ручной снимок
-- не перетирается, и тогда блок исхода называет это вслух.
--
-- Герой — Алина на деревянной лестнице под сводом: по нему видно, какого
-- размера зал. Галерея — ледяные кристаллы и узкий ход с инеем на своде.
-- Подписи — только то, что видно: что внизу хода, вода или лёд, по снимку
-- не различить, поэтому об этом ни слова.
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
       'снимок Алины Гусаковой: Алина на лестнице под сводом лавовой пещеры Горелого (миграция 1122)',
       'manual-upload',
       960,
       540,
       'Алина Гусакова',
       'migrations/photos/0148e729faaffe23aab50b19045195f4593f4640f9e0c91d6b23e1be5205c6f4.jpg'
  FROM places p
 WHERE p.id::text = 'f0ecf463-c804-44de-9b51-7a1642eaccc3'
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
       'Ледяные кристаллы в пещере',
       'Алина Гусакова',
       'migrations/photos/31b11db6aa362bc809f6cc2115a6bcca761b51e4a927986bb51fc4bd357c9eec.jpg'
  FROM places p
 WHERE p.id::text = 'f0ecf463-c804-44de-9b51-7a1642eaccc3'
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
       960,
       540,
       'Узкий ход, иней на своде',
       'Алина Гусакова',
       'migrations/photos/eca1047b9680b1a2a580daec73470396051e7056bbbe8fc8139ca4721bc4c48a.jpg'
  FROM places p
 WHERE p.id::text = 'f0ecf463-c804-44de-9b51-7a1642eaccc3'
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
   WHERE id::text = 'f0ecf463-c804-44de-9b51-7a1642eaccc3' AND is_visible AND merged_into_id IS NULL;

  IF v_ark IS NULL THEN
    RAISE WARNING '[1122] живой записи «Лавовые пещеры вулкана Горелый» нет — снимки не легли';
    RETURN;
  END IF;

  SELECT author INTO v_author FROM ai_route_images WHERE route_id = v_ark;
  IF v_author IS DISTINCT FROM 'Алина Гусакова' THEN
    RAISE WARNING '[1122] герой «Лавовые пещеры вулкана Горелый» НЕ встал: там %', COALESCE('автор «' || v_author || '»', 'строки снимка нет');
  END IF;

  SELECT count(*) INTO v_count FROM place_gallery_photos
   WHERE ark_id = v_ark AND author = 'Алина Гусакова' AND position BETWEEN 1 AND 2;
  IF v_count <> 2 THEN
    RAISE WARNING '[1122] галерея «Лавовые пещеры вулкана Горелый»: легло % кадров из 2 (позиции заняты чужими подписями?)', v_count;
  END IF;
END $$;

COMMIT;
