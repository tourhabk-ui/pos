-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 961: Скалы Три Брата — свой снимок владельца.
--
-- Долг партии 958. Там у скал снимка НЕ ПОЯВИЛОСЬ, хотя они есть на кадре с
-- Вилючинским на закате: ни одна полоса 16:9 не держит одновременно вершину
-- вулкана и скалы у нижней кромки вертикального кадра. Один снимок на две
-- карточки означал бы, что на карточке скал скал не видно. Нужен был
-- отдельный кадр — владелец прислал его 14.09, снят им самим.
--
-- ── Обрезка ───────────────────────────────────────────────────────────────
--
-- Исходник 3936x2952 (4:3), скалы посередине. Окно 16:9 полной ширины со
-- смещением 20% сверху: остаются сами скалы, вулканический хребет за
-- Авачинской губой и берег внизу — то есть и предмет, и масштаб.
--
-- Штатный cover/attention здесь не взят сознательно: на этом кадре самое
-- контрастное — зелень переднего плана справа, а не скалы. Тот же урок, что
-- в 958 на закатном снимке, где «внимание» ушло в небо.
--
-- Идемпотентно: ON CONFLICT по route_id, и уже лежащий настоящий снимок
-- (wikimedia / manual-upload) не перезаписывается — только AI-блоб или пустота.

INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: Скалы Три Брата, миграция 961',
       'manual-upload',
       1280,
       720,
       'владелец платформы',
       'migrations/photos/707fb18716257d6ebab3bca0b4b5cc240ee2175f40460839f18f4730cd19ba61.jpg'
  FROM places p
 WHERE (p.id::text = 'fd3feffa-0e07-4a29-b4c8-216666dfe1e8'
     OR p.ark_id::text = 'fd3feffa-0e07-4a29-b4c8-216666dfe1e8')
   AND p.ark_id IS NOT NULL
 LIMIT 1
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
