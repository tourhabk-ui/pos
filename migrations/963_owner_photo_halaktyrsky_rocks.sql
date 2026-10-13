-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 963: Скалы Халактырские — свой снимок владельца.
--
-- Владелец прислал 14.09 два своих кадра. На карточку идёт вид С ВЕРШИНЫ:
-- лишайниковые скалы на переднем плане и то, ради чего на них поднимаются —
-- лес до горизонта и домашние вулканы за ним. Кадр снизу, где массив виден
-- целиком, не взят: скалы на нём исписаны краской, и на карточке места это
-- первое, что читается.
--
-- Обрезка cover/centre, а не attention: исходник уже почти 16:9, а самое
-- контрастное на нём — облачное небо, куда «внимание» и ушло бы, срезав
-- скалы (урок 958).
--
-- Идемпотентно: ON CONFLICT по route_id, уже лежащий настоящий снимок
-- (wikimedia / manual-upload) не перезаписывается.

INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: Скалы Халактырские, миграция 963',
       'manual-upload',
       1280,
       720,
       'владелец платформы',
       'migrations/photos/a727c89ae39996b9283f0c2f3e6dd27678b86347fa0c2d9adafe4c58b4446d39.jpg'
  FROM places p
 WHERE (p.id::text = '4d2f90b3-a7ca-44ce-9477-c3bc26ca39f8'
     OR p.ark_id::text = '4d2f90b3-a7ca-44ce-9477-c3bc26ca39f8')
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
