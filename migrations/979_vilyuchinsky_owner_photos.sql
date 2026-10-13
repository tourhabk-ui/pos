-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 979: «Вулкан Вилючинский» — два снимка владельца.
--
-- ── Что и куда ────────────────────────────────────────────────────────────
--
-- 19.09 владелец прислал два своих кадра: сам вулкан с облачным поясом у
-- подножия и три гамула (резные деревянные идолы) на фоне хребта. Оба
-- названы им как Вилючинский.
--
--   герой     — вулкан целиком: вершина, снежники, облачный пояс;
--   галерея 1 — гамулы, за ними хребет со снежниками.
--
-- ── Почему именно эта запись ──────────────────────────────────────────────
--
-- Мест с этим именем в каталоге ТРИ, и класть надо ровно в одно (проба 525):
--
--   164f612c  «Вулкан Вилючинский»   volcano   видимое, не слитое   ← сюда
--   708c021c  «Вилючинский вулкан»   volcano   СЛИТО в 164f612c
--   8bad8fe6  «Вилючинский перевал»  mountain  видимое, отдельное место
--
-- Слитая запись снимка не получает: карточка её не открывает, и байты легли
-- бы туда, где их никто не увидит. Перевал — ОТДЕЛЬНОЕ место, и это стоит
-- держать в уме: гамулы стоят у дороги на перевале, а не на склоне вулкана.
-- Владелец назвал их вулканом, и по его слову они здесь; если решит перенести
-- на перевал — это отдельная правка, а не догадка за него.
--
-- ── Обрезка ───────────────────────────────────────────────────────────────
--
-- Окно 16:9 полной ширины, исходники 1280x960. Смещение сверху выбрано по
-- предмету кадра, а не по умолчанию: 4% у героя (вершина у верхней кромки,
-- ниже окно срезало бы её), 8% у гамулов (иначе уходят их головы). Штатный
-- cover/attention увёл бы окно в самое контрастное — в светлое небо (урок 958).
--
-- ── Как ложится ───────────────────────────────────────────────────────────
--
-- Герой: `ON CONFLICT (route_id) DO UPDATE ... WHERE model NOT IN
-- ('wikimedia','manual-upload')` — та же защита, что в 962 и 977: машинную
-- картинку настоящий снимок вытесняет, чужой настоящий снимок остаётся.
-- Галерея (968): `ON CONFLICT (ark_id, position) DO UPDATE`, повтор не
-- плодит строк.
--
-- Байты пишутся в базу, а не в хранилище, и это не нарушение правила 18.09:
-- миграция в S3 ходить не может и не должна. Ночной уборщик
-- (cron-images-to-s3) увезёт их следующим прогоном — затем он и заведён.
-- Поэтому же обнуляются `s3_url`/`s3_key`: старый объект этим байтам больше
-- не соответствует, и ссылка на него показывала бы прежний снимок.
--
-- Права: автор указан, лицензия не ставится — снимок собственный.
--
-- IDEMPOTENT

BEGIN;

-- ── Герой: вулкан с облачным поясом ───────────────────────────────────────
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: Вилючинский вулкан (миграция 979)',
       'manual-upload',
       1280,
       720,
       'владелец платформы',
       'migrations/photos/853153582f366d4ae158232755482abd3a1aeab87588ba3817c862d10ffe82cc.jpg'
  FROM places p
 WHERE p.id::text = '164f612c-32da-4f0f-b261-c45c09dc2933'
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

-- ── Галерея 1: гамулы на фоне хребта ──────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       1,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Гамулы на фоне хребта',
       'владелец платформы',
       'migrations/photos/aca97f853e5d79667d908e18fec5b7b0762d7ec113a7be82da843a6713bc4c38.jpg'
  FROM places p
 WHERE p.id::text = '164f612c-32da-4f0f-b261-c45c09dc2933'
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
