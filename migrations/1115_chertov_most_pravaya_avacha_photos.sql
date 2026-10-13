-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1115: «Чёртов мост» на Правой Аваче — новое место и пять снимков Алины Гусаковой.
--
-- ── Почему новое место ────────────────────────────────────────────────────
--
-- Владелец 30.09 прислал снимок карточки места из картографического
-- приложения («Чёртов мост», Елизовский район, 53.520264, 158.127222) и пять
-- кадров Алины Гусаковой. В справочнике платформы такого места нет: MCP
-- get_place_info по «Чёртов мост» и «Чертов мост» отвечает «места нет в
-- справочнике». В репозитории есть только «Кекур Чёртов палец» (966) —
-- другой объект на побережье, в 77 км отсюда.
--
-- ── Откуда координата ─────────────────────────────────────────────────────
--
-- Из OpenStreetMap, node 14123795049 (API openstreetmap.org, 30.09):
--
--   name «Чертов Мост через Правую Авачу» · 53.5204782 / 158.1273643
--   (добавлен 25.08.2026, одиночная точка без других тегов)
--
-- Точка владельца лежит от неё в 30 метрах. Проба Overpass в радиусе 3 км
-- (30.09) называет рядом реку Правая Авача (way 1050764436; 1,7 км — это до
-- центра записи линии, а не до русла) и урочище «Узкое Место» (1,3 км).
-- `coord_source` = 'external'.
--
-- ── Что в описании и почему только это ────────────────────────────────────
--
-- Только то, что видно на снимках или названо в OSM: каньон со скальными
-- стенками, несколько брёвен поперёк щели без перил и настила, перекаты,
-- берёзы, шиповник (ягоды на кадре), иван-чай. Фраза с карточки приложения
-- про «площадку для кемпинга с костровищем, столом и лавочками» в описание
-- НЕ взята: на снимках её нет, и проверить её нечем (§4.0).
--
-- ── Кадры и права ─────────────────────────────────────────────────────────
--
-- Автор — Алина Гусакова. Владелец, дословно: «фото Алины Гусаковой
-- разрешение на публикацию есть». Автор пишется в `author`; `license` не
-- ставится — лицензию никто не называл, и разрешение на публикацию это не
-- лицензия (тот же порядок, что у снимка Склярова в 1001).
--
-- Все пять исходников вертикальные, 963x1279. Окно 16:9 полной ширины
-- (963x542) со смещением сверху под сюжет каждого кадра, 960x540 — без
-- растяжения до 1280: исходник уже, чем привычные 1280x720. JPEG q82.
-- Смещения: герой 60, галерея 470 / 300 / 220 / 400.
--
-- Герой — брёвна над каньоном (кадр, по которому место и называется),
-- галерея — позиции 1–4. Байты увезёт уборщик cron-images-to-s3 (§4.1).
--
-- Тип — 'river': каньон реки, отдельного типа для каньона в данных нет.
-- Зона НЕ заполняется — перечня значений в коде нет, наугад значит
-- сочинить (§4.0, как в 997 и 1038).
--
-- ПОСЛЕ ВЫКАТА — перезалив пакетов карты (`map-places-build.yml`,
-- upload:true): полевая карта читает статичные пакеты (§4.1).
--
-- IDEMPOTENT

BEGIN;

-- ── 1. Место ──────────────────────────────────────────────────────────────
-- Не заводится, если живое место с этим именем уже появилось другим путём.
INSERT INTO places (id, name, ark_id, lat, lng, location_type,
                    is_visible, description, coord_source, coord_source_at,
                    source_name, source_url, created_at, updated_at)
SELECT '48462267-c7c8-4500-8c5c-1a9b47cdb435',
       'Чёртов мост',
       '2561069a-471a-45a9-ba6c-873ad2d77f09',
       53.5204782, 158.1273643,
       'river',
       TRUE,
       'Чёртов мост — переход через узкий скальный каньон реки Правая Авача в Елизовском районе. Там, где река сжата отвесными каменными стенками, через щель переброшено несколько брёвен. Перил и настила нет: это стволы над быстрой водой, и мокрыми они скользкие. Выше и ниже каньона река идёт бурными перекатами. Берега заросли берёзовым лесом, шиповником и иван-чаем; осенью склоны становятся жёлтыми и красными.',
       'external', NOW(),
       'OpenStreetMap',
       'https://www.openstreetmap.org/node/14123795049',
       NOW(), NOW()
 WHERE NOT EXISTS (
         SELECT 1 FROM places q
          WHERE q.id::text <> '48462267-c7c8-4500-8c5c-1a9b47cdb435'
            AND q.merged_into_id IS NULL
            AND q.is_visible
            AND (q.name ILIKE '%Чёртов мост%' OR q.name ILIKE '%Чертов мост%')
       )
ON CONFLICT (id) DO NOTHING;

-- ── 1а. Адрес по имени ────────────────────────────────────────────────────
-- Триггера на slug у мест нет: без этого шага место жило бы по uuid (перепись
-- 1111/1112). Тем же translit_ru_slug и тем же условием: адрес берётся,
-- только если свободен и среди мест, и среди маршрутов.
UPDATE places p
   SET slug = translit_ru_slug(p.name)
 WHERE p.id::text = '48462267-c7c8-4500-8c5c-1a9b47cdb435'
   AND p.slug IS NULL
   AND NOT EXISTS (SELECT 1 FROM places x WHERE x.slug = translit_ru_slug(p.name))
   AND NOT EXISTS (SELECT 1 FROM kamchatka_routes r WHERE r.slug = translit_ru_slug(p.name));

-- ── 2. Герой ──────────────────────────────────────────────────────────────
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок Алины Гусаковой: брёвна над каньоном Правой Авачи (миграция 1115)',
       'manual-upload',
       960,
       540,
       'Алина Гусакова',
       'migrations/photos/d881eafe736334371c4b23ec602576f87d3db7fbad990d50ef309e984bc7b220.jpg'
  FROM places p
 WHERE p.id::text = '48462267-c7c8-4500-8c5c-1a9b47cdb435'
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

-- ── 3.1. Галерея, позиция 1 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       1,
       NULL::bytea,
       'image/jpeg',
       960,
       540,
       'Бревенчатый переход у края каньона',
       'Алина Гусакова',
       'migrations/photos/b621b82fe302e26e79393d3c24e8daa404a29bdf804811a4702f6b7c424919d9.jpg'
  FROM places p
 WHERE p.id::text = '48462267-c7c8-4500-8c5c-1a9b47cdb435'
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

-- ── 3.2. Галерея, позиция 2 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       2,
       NULL::bytea,
       'image/jpeg',
       960,
       540,
       'Поток в скальном каньоне, шиповник на краю',
       'Алина Гусакова',
       'migrations/photos/bfe4fa9729a4586360566016941575bb66d1db3eae192448fd738a7c12c1456a.jpg'
  FROM places p
 WHERE p.id::text = '48462267-c7c8-4500-8c5c-1a9b47cdb435'
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

-- ── 3.3. Галерея, позиция 3 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       3,
       NULL::bytea,
       'image/jpeg',
       960,
       540,
       'Перекаты Правой Авачи у каньона',
       'Алина Гусакова',
       'migrations/photos/828a5c72933dc7302f1d5275aab5d0a4f28c6ce18b8b63a239d98712a8c98de6.jpg'
  FROM places p
 WHERE p.id::text = '48462267-c7c8-4500-8c5c-1a9b47cdb435'
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

-- ── 3.4. Галерея, позиция 4 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       4,
       NULL::bytea,
       'image/jpeg',
       960,
       540,
       'Река в осеннем лесу, иван-чай на берегу',
       'Алина Гусакова',
       'migrations/photos/da00eff47a5103014d62c08e7fc579c0b0c5872cffb6fb3334181655cc31ae4a.jpg'
  FROM places p
 WHERE p.id::text = '48462267-c7c8-4500-8c5c-1a9b47cdb435'
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
   WHERE id::text = '48462267-c7c8-4500-8c5c-1a9b47cdb435' AND is_visible;

  IF v_ark IS NULL THEN
    RAISE WARNING '[1115] «Чёртов мост» не заведён (живое место с этим именем уже есть?) — снимки не легли';
    RETURN;
  END IF;

  SELECT author INTO v_author FROM ai_route_images WHERE route_id = v_ark;
  IF v_author IS DISTINCT FROM 'Алина Гусакова' THEN
    RAISE WARNING '[1115] герой «Чёртова моста» НЕ встал: там %', COALESCE('автор «' || v_author || '»', 'строки снимка нет');
  END IF;

  SELECT count(*) INTO v_count FROM place_gallery_photos
   WHERE ark_id = v_ark AND author = 'Алина Гусакова' AND position BETWEEN 1 AND 4;
  IF v_count <> 4 THEN
    RAISE WARNING '[1115] галерея «Чёртова моста»: легло % кадров из 4', v_count;
  END IF;
END $$;

COMMIT;
