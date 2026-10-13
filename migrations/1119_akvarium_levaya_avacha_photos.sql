-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1119: «Урочище Аквариум» на Левой Аваче — новое место и семь кадров Алины Гусаковой.
--
-- ── Почему новое место ────────────────────────────────────────────────────
--
-- Владелец 30.09 прислал семь кадров Алины Гусаковой со словами «Урочище
-- Аквариум на реке Левая Авача». В справочнике такого места нет: проба 626
-- (/api/places?q=Аквариум, /api/routes/search?q=Аквариум) — пусто и среди
-- мест, и среди маршрутов.
--
-- ── Откуда координата ─────────────────────────────────────────────────────
--
-- Ни один открытый справочник её не дал. Nominatim по «Аквариум Левая Авача»
-- и «урочище Аквариум Камчатский край» — пусто (проба 627); статьи в
-- Википедии нет, поиск по ней пуст (628); Overpass не ответил ни с одного из
-- трёх зеркал (626–628), реестр ООПТ oopt.aari.ru — тоже.
--
-- Координата взята с карточки места в картографическом приложении — снимок
-- экрана прислал владелец 30.09: «Урочище Аквариум», Место, Елизовский район,
-- 53.530670, 158.236604. На той же карте рядом отмечены «Скалы» — они есть и
-- на кадрах. `coord_source` = 'external' (взята из внешнего справочника), и
-- права утверждать больше, чем «так записано в приложении», у неё нет.
-- Урочище — протяжённый участок долины, точка не место съёмки.
--
-- ── Что в описании и почему только это ────────────────────────────────────
--
-- Статус памятника природы — с таблички на кадре (Правительство Камчатского
-- края, «Памятник природы регионального значения „Урочище Аквариум на реке
-- Левая Авача“»). Остальное видно на снимках: перекаты, скальные останцы,
-- берёзовый лес, деревянный мост с перилами, площадка у воды, осенние цвета.
--
-- Чего в описании НЕТ. Про прозрачность воды, которой урочище, вероятно,
-- обязано названием, — ни слова: по снимкам этого не утверждаю. Порядок
-- посещения с карточки приложения («бесплатно по раз…») не взят: текст
-- обрезан, дочитать его нечем (§4.0).
--
-- ── Кадры и права ─────────────────────────────────────────────────────────
--
-- Автор — Алина Гусакова, разрешение на публикацию её снимков владелец
-- подтвердил 30.09 (как в 1115). `license` не ставится: разрешение на
-- публикацию — не лицензия. На пятом кадре галереи — сама Алина: владелец,
-- дословно, «девушку тоже поставь, это Алина».
--
-- Все семь кадров портретные (963x1279, табличка — 1928x2560). Обрезка 16:9
-- полосой во всю ширину со смещением сверху под сюжет, 960x540, JPEG q82.
-- Герой — река с останцами и площадкой; галерея — позиции 1–6.
-- Байты увезёт уборщик cron-images-to-s3 (§4.1).
--
-- Тип — 'river': урочище здесь — участок долины реки, отдельного типа нет.
-- Зона НЕ заполняется — перечня значений в коде нет (§4.0, как в 1115).
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
SELECT 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf',
       'Урочище Аквариум',
       '54b26e8f-78f8-4377-8880-f45abae8dd70',
       53.530670, 158.236604,
       'river',
       TRUE,
       'Урочище Аквариум — участок долины реки Левая Авача в Елизовском районе, памятник природы регионального значения: у моста стоит табличка Правительства Камчатского края «Урочище Аквариум на реке Левая Авача». Река идёт здесь быстрыми перекатами, над долиной поднимаются тёмные скальные останцы. Берега заросли берёзовым лесом и кустарником. Через реку переброшен деревянный мост с перилами, у воды есть деревянная площадка. Осенью склоны становятся жёлтыми и красными.',
       'external', NOW(),
       'картографическое приложение (снимок экрана владельца 30.09)',
       NULL,
       NOW(), NOW()
 WHERE NOT EXISTS (
         SELECT 1 FROM places p2
          WHERE p2.id::text <> 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf'
            AND p2.merged_into_id IS NULL
            AND p2.is_visible
            AND p2.name ILIKE '%Аквариум%'
       )
ON CONFLICT (id) DO NOTHING;

-- ── 1а. Адрес по имени ────────────────────────────────────────────────────
-- Триггера на slug у мест нет (перепись 1111/1112): тем же translit_ru_slug и
-- тем же условием, что в 1115, — адрес берётся, только если свободен.
UPDATE places p
   SET slug = translit_ru_slug(p.name)
 WHERE p.id::text = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf'
   AND p.slug IS NULL
   AND NOT EXISTS (SELECT 1 FROM places x WHERE x.slug = translit_ru_slug(p.name))
   AND NOT EXISTS (SELECT 1 FROM kamchatka_routes r WHERE r.slug = translit_ru_slug(p.name));

-- ── 2. Герой ──────────────────────────────────────────────────────────────
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок Алины Гусаковой: Левая Авача в урочище Аквариум (миграция 1119)',
       'manual-upload',
       960,
       540,
       'Алина Гусакова',
       'migrations/photos/0fa01233a677c2b79ffed3242079499343d31039e52586667d0301aede45f817.jpg'
  FROM places p
 WHERE p.id::text = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf'
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
       'Скальные останцы над долиной Левой Авачи',
       'Алина Гусакова',
       'migrations/photos/a9ffb5a0cea9f046d3be61fdd57258adcb1cf473eb3623267bb70eb735f5c385.jpg'
  FROM places p
 WHERE p.id::text = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf'
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
       'Перекаты Левой Авачи с деревянного моста',
       'Алина Гусакова',
       'migrations/photos/533aecd121df375a1a31eac25565ef332c37314a3007711f1132cc15729cd2d0.jpg'
  FROM places p
 WHERE p.id::text = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf'
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
       'Берёзы и кустарник на берегу Левой Авачи',
       'Алина Гусакова',
       'migrations/photos/69aca2cf6e090f4a4e902b85ca87f4468f6f63f1eef2e34dee7798271da4da63.jpg'
  FROM places p
 WHERE p.id::text = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf'
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
       'Осенние листья у воды',
       'Алина Гусакова',
       'migrations/photos/5df09e1b4e0f1ad4578e7cedcc9f636156e08d12b53fefca6207dd65691e1acb.jpg'
  FROM places p
 WHERE p.id::text = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf'
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

-- ── 3.5. Галерея, позиция 5 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       5,
       NULL::bytea,
       'image/jpeg',
       960,
       540,
       'Алина Гусакова на берегу Левой Авачи',
       'Алина Гусакова',
       'migrations/photos/c9fa32780ef7542f1d5338e659aef2426a67835311957d36cacacd3e93163ca0.jpg'
  FROM places p
 WHERE p.id::text = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf'
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

-- ── 3.6. Галерея, позиция 6 ──────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       6,
       NULL::bytea,
       'image/jpeg',
       960,
       540,
       'Табличка памятника природы у моста через Левую Авачу',
       'Алина Гусакова',
       'migrations/photos/a8b73722e61a146622f015f4e18f74682a7d20c9fd1ad50a577542046aa93839.jpg'
  FROM places p
 WHERE p.id::text = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf'
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
   WHERE id::text = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf' AND is_visible;

  IF v_ark IS NULL THEN
    RAISE WARNING '[1119] «Урочище Аквариум» не заведено (живое место с этим именем уже есть?) — снимки не легли';
    RETURN;
  END IF;

  SELECT author INTO v_author FROM ai_route_images WHERE route_id = v_ark;
  IF v_author IS DISTINCT FROM 'Алина Гусакова' THEN
    RAISE WARNING '[1119] герой «Урочища Аквариум» НЕ встал: там %', COALESCE('автор «' || v_author || '»', 'строки снимка нет');
  END IF;

  SELECT count(*) INTO v_count FROM place_gallery_photos
   WHERE ark_id = v_ark AND author = 'Алина Гусакова' AND position BETWEEN 1 AND 6;
  IF v_count <> 6 THEN
    RAISE WARNING '[1119] галерея «Урочища Аквариум»: легло % кадров из 6', v_count;
  END IF;
END $$;

COMMIT;
