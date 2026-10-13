-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 977: «Маяк Петропавловский» — три снимка владельца.
--
-- ── Что было ──────────────────────────────────────────────────────────────
--
-- 18.09 владелец открыл карточку маяка и увидел серую заглушку: «без фото
-- хотя там лично мои фотографии были». Его кадры 14.09 легли миграцией 962
-- на СОСЕДНЮЮ запись — «Мыс Маячный» (3268583a, cape), а маяк живёт
-- отдельной записью (0aa97c3c-c4d7-496d-a879-7fa065d7f8de, historical).
--
-- Миграция 976 попыталась скопировать снимок мыса на маяк и НЕ СРАБОТАЛА, не
-- сказав об этом: у ark_id маяка уже лежала машинная картинка, а копия шла с
-- `ON CONFLICT (route_id) DO NOTHING`. Проба 520 показала это фактом —
-- раздача /api/images/route/<ark_id> вернула 200 и 515 КБ с подписью
-- «CREATOR: gd-jpeg», то есть генерацию. Карточка её не показывает намеренно
-- (решение владельца 17.07: только wikimedia и ручная загрузка), и снаружи
-- занятая строка была неотличима от пустой.
--
-- ── Что теперь ────────────────────────────────────────────────────────────
--
-- Владелец прислал три СВОИХ кадра самого маяка. Копировать у мыса больше
-- нечего: у маяка есть собственные снимки.
--
--   герой — башня крупно, горящий огонь, постройки поста;
--   галерея 1 — маяк в своём ландшафте: сопка, посёлок, цистерны;
--   галерея 2 — обрыв мыса, кекур с чайками, океан.
--
-- Обрезка у всех одна: окно 16:9 полной ширины, исходник вертикальный
-- 3000x4000 после разворота по EXIF. Смещение сверху разное и выбрано по
-- предмету кадра, а не по умолчанию: 40% у героя (иначе окно уезжает в пустое
-- небо над фонарём), 33% у первого галерейного (чтобы вошли и сопка, и
-- посёлок), 28% у второго (кекур с птицами у нижней трети). Штатный
-- cover/attention увёл бы окно в самое контрастное место — в светлое небо
-- (урок 958).
--
-- ── Почему герой перезаписывается, а галерея вставляется ──────────────────
--
-- У героя `ON CONFLICT (route_id) DO UPDATE ... WHERE model NOT IN
-- ('wikimedia','manual-upload')` — та же защита, что в 962: машинную картинку
-- настоящий снимок вытесняет, а чужой настоящий снимок остаётся нетронутым.
-- Именно этой ветки не хватало 976: DO NOTHING молчал там, где надо было
-- заменить генерацию.
--
-- Галерея (таблица из 968) — `ON CONFLICT (ark_id, position) DO UPDATE`:
-- повторный прогон кладёт те же байты на те же позиции, а не плодит строки.
--
-- Права: автор указан, лицензия не проставляется — снимок собственный, и
-- приписывать ему чужую лицензию не за что.
--
-- IDEMPOTENT

BEGIN;

-- ── Герой: башня крупно ───────────────────────────────────────────────────
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: Маяк Петропавловский, башня крупно (миграция 977)',
       'manual-upload',
       1280,
       720,
       'владелец платформы',
       'migrations/photos/226d5f1e5626972d0fea94218d746c5c0ffdda92b5b4871a439c94005ac2fea7.jpg'
  FROM places p
 WHERE p.id::text = '0aa97c3c-c4d7-496d-a879-7fa065d7f8de'
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
 WHERE ai_route_images.model NOT IN ('wikimedia', 'manual-upload');

-- ── Галерея 1: Маяк в своём ландшафте ──
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       1,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Маяк в своём ландшафте',
       'владелец платформы',
       'migrations/photos/bf5377184223f63dcda51db2ca732438d8abea6c0645263137572edac97eca54.jpg'
  FROM places p
 WHERE p.id::text = '0aa97c3c-c4d7-496d-a879-7fa065d7f8de'
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

-- ── Галерея 2: Обрыв мыса и кекур с чайками ──
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       2,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Обрыв мыса и кекур с чайками',
       'владелец платформы',
       'migrations/photos/5bf26a6080be0e710941c197d4de67697a778dc80fcd3bc1f02bc3bf775e30d7.jpg'
  FROM places p
 WHERE p.id::text = '0aa97c3c-c4d7-496d-a879-7fa065d7f8de'
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

COMMIT;
