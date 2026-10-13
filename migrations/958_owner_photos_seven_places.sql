-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 958: свои снимки владельца — семь мест одной партией.
--
-- Присланы владельцем 14.09.2026 в переписке; авторство подтверждено им же
-- («сам фотографировал», на отдельный вопрос по двум снимкам — «оба мои,
-- снимал сам»). Кладутся тем же путём и в том же каноне, что миграция 930
-- (озеро Синичкино) и POST /api/admin/places/[id]/photo: sharp → 1280x720 →
-- mozjpeg q85, байты прямо в SQL. Через миграцию, а не через эндпоинт,
-- потому что деплой применяет её сам — без ручного шага с секретом.
--
-- ── Почему обрезка у снимков РАЗНАЯ ───────────────────────────────────────
--
-- Штатный cover/attention гонится за контрастом, а не за предметом, и на
-- вертикальных кадрах это ломает карточку. Проверено прогонами на самих
-- файлах: у снимка Вилючинского на закате «внимание» ушло на небо — вулкан
-- срезало пополам, скалы Три Брата исчезли из кадра совсем. Поэтому там, где
-- сюжет у нижнего края, окно 16:9 выбирается ЯВНО и до ресайза.
--
-- Каждая обрезка названа в комментарии к своей вставке — чтобы следующий,
-- кто заменит снимок, знал, что число не случайное.
--
-- ── Чего здесь нет ────────────────────────────────────────────────────────
--
-- Скалы Три Брата своего снимка не получили, хотя они есть на кадре с
-- Вилючинским. Ни одна полоса 16:9 не держит одновременно вершину вулкана и
-- скалы у нижнего края: они в разных концах вертикального кадра. Один снимок
-- на две карточки означал бы, что на карточке скал скал не видно. Нужен
-- отдельный кадр.
--
-- Идемпотентно: ON CONFLICT по route_id, и уже лежащий НАСТОЯЩИЙ снимок
-- (wikimedia / manual-upload) не перезаписывается — только AI-блоб или пустота.

-- Экструзия Верблюд: cover/attention
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: Экструзия Верблюд, миграция 958',
       'manual-upload',
       1280,
       720,
       'владелец платформы',
       'migrations/photos/8553f67769b6977a0c140e7803860c1fdbc9e0008693a606577928298055eaa7.jpg'
  FROM places p
 WHERE (p.id::text IN ('32aa0d20-10d9-4fbb-a1f7-b90f327b7687')
       OR p.ark_id::text IN ('32aa0d20-10d9-4fbb-a1f7-b90f327b7687'))
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

-- Халактырский пляж: окно 16:9 со смещением 36% сверху
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: Халактырский пляж, миграция 958',
       'manual-upload',
       1280,
       720,
       'владелец платформы',
       'migrations/photos/0e929b45c16c973f195cefd54069217965bcc8d0b1e205fd1ad1d2d143c879ff.jpg'
  FROM places p
 WHERE (p.id::text IN ('49a1d46a-704b-4307-bb6a-fea5988ec4f8')
       OR p.ark_id::text IN ('49a1d46a-704b-4307-bb6a-fea5988ec4f8'))
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

-- Вилючинский вулкан: cover/centre
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: Вилючинский вулкан, миграция 958',
       'manual-upload',
       1280,
       720,
       'владелец платформы',
       'migrations/photos/3d62dec14e03a014204028d56d1c73e8d3394ccd37a7e33664126696a9744b8e.jpg'
  FROM places p
 WHERE (p.id::text IN ('df06c8b4-f21e-4d1f-b12b-2576b6c56f87')
       OR p.ark_id::text IN ('df06c8b4-f21e-4d1f-b12b-2576b6c56f87'))
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

-- Курильское озеро: окно 16:9 со смещением 62% сверху
-- Две записи одного озера в каталоге; снимок кладётся обеим — какая из них
-- видима, репозиторий не знает, а гадать здесь нечем.
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: Курильское озеро, миграция 958',
       'manual-upload',
       1280,
       720,
       'владелец платформы',
       'migrations/photos/84b7294d8bc4892a9aefd9c649ad207cf4f94b4cb5d79cdb6dc6770d8b2bc750.jpg'
  FROM places p
 WHERE (p.id::text IN ('d7e11485-5444-4ded-8dd8-c7da01c9d5a9', '630819da-48d1-4bb8-99c9-3b190d6ae26c')
       OR p.ark_id::text IN ('d7e11485-5444-4ded-8dd8-c7da01c9d5a9', '630819da-48d1-4bb8-99c9-3b190d6ae26c'))
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

-- Мутновский вулкан: окно 940x529 от левого края
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: Мутновский вулкан, миграция 958',
       'manual-upload',
       1280,
       720,
       'владелец платформы',
       'migrations/photos/a496a386c922e4fa9a00d2fd750d604cb0f7ae352733f5dc19917c010f55b056.jpg'
  FROM places p
 WHERE (p.id::text IN ('acb8f5d3-9b44-48ec-9a81-1c8c71e451b9')
       OR p.ark_id::text IN ('acb8f5d3-9b44-48ec-9a81-1c8c71e451b9'))
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

-- Кутхины Баты: cover/attention
-- Место ищется по имени: точного id в каталоге миграций нет. Не нашлось —
-- строка просто не создаётся, и это видно по карточке после выката.
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: Кутхины Баты, миграция 958',
       'manual-upload',
       1280,
       720,
       'владелец платформы',
       'migrations/photos/ef667c9d78d260906132979f244f8de47af922cb251d9f660549549df1d899ed.jpg'
  FROM places p
 WHERE p.name ILIKE '%Кутхины%'
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

-- Вулкан Ходутка: окно 16:9 от верхней кромки
-- id рукописный тестовый (a1b2c3d4-...), но запись НАСТОЯЩАЯ: подтверждено
-- миграцией 851 и разбором в #1830. Не опечатка и не заглушка.
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: Вулкан Ходутка, миграция 958',
       'manual-upload',
       1280,
       720,
       'владелец платформы',
       'migrations/photos/8247e0568e2e4bc306465bbd355e750756f925918bb7cd0fdf7b5ed836821886.jpg'
  FROM places p
 WHERE (p.id::text IN ('a1b2c3d4-e5f6-7890-abcd-ef0123456789')
       OR p.ark_id::text IN ('a1b2c3d4-e5f6-7890-abcd-ef0123456789'))
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
