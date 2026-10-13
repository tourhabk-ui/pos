-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 964: «Раздолье Камчатки» — свой снимок владельца.
--
-- Владелец прислал 14.09 пять своих кадров базы и уточнил: это горячие
-- источники. Место заведено миграцией 925 как вторая база у Зеленовских
-- озерков, на своей скважине.
--
-- ── Какой из пяти и почему ────────────────────────────────────────────────
--
-- Взят общий план: бассейн на переднем плане, корпус и ванны за ним, пар над
-- водой. Люди в кадре есть, они мелкие и далёкие — для общественного
-- бассейна это правда о месте, а не помеха.
--
-- Остальные четыре отвергнуты по одной причине: на них люди в купальниках
-- крупно и узнаваемо. Публичная карточка места — не то, где чужое лицо в
-- плавках уместно, и согласия этих людей у нас нет. Это не про красоту
-- кадра, а про то, чего платформа не делает по умолчанию.
--
-- Обрезка: окно 16:9 полной ширины со смещением 36% сверху. Исходник
-- вертикальный; ниже окна пустая плитка на треть кадра, выше — небо.
--
-- Идемпотентно: ON CONFLICT по route_id, уже лежащий настоящий снимок
-- (wikimedia / manual-upload) не перезаписывается.

INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: Раздолье Камчатки, миграция 964',
       'manual-upload',
       1280,
       720,
       'владелец платформы',
       'migrations/photos/f529c014929f0d1d119cea4faf4111617e4d45f19f24f4a74405907fb235efd0.jpg'
  FROM places p
 WHERE (p.id::text = 'b2f6d8e4-0a53-4c29-9f18-4da6e3c7b521'
     OR p.ark_id::text = 'b2f6d8e4-0a53-4c29-9f18-4da6e3c7b521')
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
