-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 959: свои снимки владельца — Паужетские и Дачные источники.
--
-- Продолжение партии 958, тот же путь и тот же канон: sharp → 1280x720 →
-- mozjpeg q85, байты прямо в SQL, model = manual-upload. Снимки присланы
-- владельцем 14.09, авторство подтверждено им же.
--
-- ── Обрезка ───────────────────────────────────────────────────────────────
--
-- Оба кадра вертикальные, и обоим штатный cover/attention не годится: он
-- гонится за контрастом, а не за предметом (на кадре с Вилючинским это увело
-- рамку в закатное небо и выбросило из неё сам сюжет — см. 958). Здесь окно
-- 16:9 выбрано явно и ДО ресайза.
--
-- Паужетка — смещение 30% сверху: грязевой котёл с паром в середине кадра,
-- выше только пар, ниже только глина.
-- Дачные — смещение 38%: гостиница, склон с парящими выходами справа и вода
-- внизу. Кадр про гостиницу, но читается как вид самих источников, потому что
-- фумаролы в нём видны; если решите, что карточке нужен снимок самих ванн —
-- заменится поверх, условие ON CONFLICT это позволяет.
--
-- ── Где репозиторий не знает и говорит об этом ────────────────────────────
--
-- Паужетские источники в каталоге НЕСКОЛЬКИМИ записями (найдено четыре разных
-- id по миграциям 090 и 100), какая из них видима — отсюда не видно. Снимок
-- кладётся всем одноимённым: лишние уйдут при чистке дублей, а карточка без
-- фото не останется. То же решение, что для Курильского озера в 958.
--
-- Это уже третий случай за день (Курильское, Кутхины, Паужетка) — дубли мест
-- не единичны, и разбирать их надо переписью, а не по одному в миграциях.
--
-- Идемпотентно: ON CONFLICT по route_id, и уже лежащий НАСТОЯЩИЙ снимок
-- (wikimedia / manual-upload) не перезаписывается — только AI-блоб или пустота.

-- Паужетские термальные источники: окно 16:9, смещение 30% сверху
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: Паужетские термальные источники, миграция 959',
       'manual-upload',
       1280,
       720,
       'владелец платформы',
       'migrations/photos/5b8e48298ff3a359b4663691c3dd5598ae2db08a475cc3d97ebc67a0a50ce33e.jpg'
  FROM places p
 WHERE p.name ILIKE '%Паужетские%'
   AND p.ark_id IS NOT NULL
ON CONFLICT (route_id) DO UPDATE
   SET image_data = EXCLUDED.image_data,
       s3_url     = NULL,
       s3_key     = EXCLUDED.s3_key,
       mime_type  = EXCLUDED.mime_type,
       prompt     = EXCLUDED.prompt,
       model      = EXCLUDED.model,
       width      = EXCLUDED.width,
       height     = EXCLUDED.height,
       author     = EXCLUDED.author,
       created_at = NOW()
 WHERE ai_route_images.model NOT IN ('wikimedia', 'manual-upload');

-- Дачные горячие источники: окно 16:9, смещение 38% сверху
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: Дачные горячие источники, миграция 959',
       'manual-upload',
       1280,
       720,
       'владелец платформы',
       'migrations/photos/62abe71c1e41ca0ade614b8f436978eb79c0a5d8e0e55b8f9a33241ebf39620f.jpg'
  FROM places p
 WHERE (p.id::text IN ('2bf92082-0daf-4770-8031-a51c0f355be8', 'c3a32e0a-9b5f-4c7e-8d41-3f2a1e0c8b56')
       OR p.ark_id::text IN ('2bf92082-0daf-4770-8031-a51c0f355be8', 'c3a32e0a-9b5f-4c7e-8d41-3f2a1e0c8b56'))
   AND p.ark_id IS NOT NULL
ON CONFLICT (route_id) DO UPDATE
   SET image_data = EXCLUDED.image_data,
       s3_url     = NULL,
       s3_key     = EXCLUDED.s3_key,
       mime_type  = EXCLUDED.mime_type,
       prompt     = EXCLUDED.prompt,
       model      = EXCLUDED.model,
       width      = EXCLUDED.width,
       height     = EXCLUDED.height,
       author     = EXCLUDED.author,
       created_at = NOW()
 WHERE ai_route_images.model NOT IN ('wikimedia', 'manual-upload');
