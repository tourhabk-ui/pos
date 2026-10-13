-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1129: «Урочище Аквариум» — кадры Алины Гусаковой из 1119 переложены в 3:4.
--
-- Владелец 01.10: «остальные фото Алины тоже переделай в 3:4». Карточка
-- места показывает снимки в рамке во всю ширину и высотой 62% экрана — на
-- телефоне это почти 3:4, и полоса 16:9, которой 1119 их положила, там
-- режется до центральных 40% ширины: человек у края кадра пропадал.
-- Теперь кадр — вертикальный 3:4 из того же исходника (960x1280, у узкого
-- исходника — его родная ширина), JPEG q72. Подписи и порядок те же.
--
-- Только UPDATE строк, которые положила 1119: автор «Алина Гусакова», та же позиция.
-- Чужой снимок на той же позиции не тронется. s3_url сбрасывается — новые
-- байты увезёт cron-images-to-s3 (§4.1); created_at = NOW() меняет адрес
-- снимка (?v=), и телефон не покажет старый кадр из кэша.
--
-- IDEMPOTENT

BEGIN;

-- ── Герой ─────────────────────────────────────────────────────────────────
UPDATE ai_route_images i
   SET image_data = NULL, s3_key = 'migrations/photos/ce682d911b587d052881445dcd015c6fc669e96ec69d33a63b2058d36c22a2a0.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf'
   AND i.route_id = p.ark_id
   AND i.author = 'Алина Гусакова';

-- ── Галерея, позиция 1 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/2ba9bb9a786f2be5c10b880501a289df3959584fc6416a6061e363761c19caa0.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf'
   AND g.ark_id = p.ark_id
   AND g.position = 1
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 2 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/f5af7b6dfa4261f852d71aa9dd4b686781aaf9432b0a8d151a4c23963fde9f5e.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf'
   AND g.ark_id = p.ark_id
   AND g.position = 2
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 3 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/da8c5524f9a594e97584acc8fb51556044e1fa0eb23b1a572ff8fd025d736f9d.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf'
   AND g.ark_id = p.ark_id
   AND g.position = 3
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 4 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/cbaca84dd74b12f5e8c12ed22c232ea1923d87cfe01125cc9d03a0aae75d0611.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf'
   AND g.ark_id = p.ark_id
   AND g.position = 4
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 5 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/a51e7af336fb7f0b63da46170e33355fb4c2656f8ccdb784bb720876d9ac186f.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf'
   AND g.ark_id = p.ark_id
   AND g.position = 5
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 6 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/f58eef85aecf5f053fb71491e722f20e5eef055a8522167abc3031e3fd7d9706.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf'
   AND g.ark_id = p.ark_id
   AND g.position = 6
   AND g.author = 'Алина Гусакова';

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM ai_route_images i JOIN places p ON i.route_id = p.ark_id
   WHERE p.id::text = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf' AND i.author = 'Алина Гусакова' AND i.height > i.width;
  IF v_n <> 1 THEN
    RAISE WARNING '[1129] герой «Урочище Аквариум» не в 3:4 (найдено вертикальных: %)', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM place_gallery_photos g JOIN places p ON g.ark_id = p.ark_id
   WHERE p.id::text = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf' AND g.author = 'Алина Гусакова' AND g.position BETWEEN 1 AND 6 AND g.height > g.width;
  IF v_n <> 6 THEN
    RAISE WARNING '[1129] галерея «Урочище Аквариум»: в 3:4 % кадров из 6', v_n;
  END IF;
END $$;

COMMIT;
