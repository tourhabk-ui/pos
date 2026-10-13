-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1132: «Лавовые пещеры вулкана Горелый» — кадры Алины Гусаковой из 1122 переложены в 3:4.
--
-- Владелец 01.10: «остальные фото Алины тоже переделай в 3:4». Карточка
-- места показывает снимки в рамке во всю ширину и высотой 62% экрана — на
-- телефоне это почти 3:4, и полоса 16:9, которой 1122 их положила, там
-- режется до центральных 40% ширины: человек у края кадра пропадал.
-- Теперь кадр — вертикальный 3:4 из того же исходника (960x1280, у узкого
-- исходника — его родная ширина), JPEG q72. Подписи и порядок те же.
--
-- Только UPDATE строк, которые положила 1122: автор «Алина Гусакова», та же позиция.
-- Чужой снимок на той же позиции не тронется. s3_url сбрасывается — новые
-- байты увезёт cron-images-to-s3 (§4.1); created_at = NOW() меняет адрес
-- снимка (?v=), и телефон не покажет старый кадр из кэша.
--
-- IDEMPOTENT

BEGIN;

-- ── Герой ─────────────────────────────────────────────────────────────────
UPDATE ai_route_images i
   SET image_data = NULL, s3_key = 'migrations/photos/134d91de24091f7fbba5aba6a1bd59d455fd995f4f937f1c8ad6d89b4fd11594.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'f0ecf463-c804-44de-9b51-7a1642eaccc3'
   AND i.route_id = p.ark_id
   AND i.author = 'Алина Гусакова';

-- ── Галерея, позиция 1 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/a2c089a18022927e691f843c210011c4261130e70b430344f3550aadbd9966a2.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'f0ecf463-c804-44de-9b51-7a1642eaccc3'
   AND g.ark_id = p.ark_id
   AND g.position = 1
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 2 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/16043fbd67dd28781e921b08518af1256e9988e99f5f86eb6acf58f9feb4a943.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'f0ecf463-c804-44de-9b51-7a1642eaccc3'
   AND g.ark_id = p.ark_id
   AND g.position = 2
   AND g.author = 'Алина Гусакова';

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM ai_route_images i JOIN places p ON i.route_id = p.ark_id
   WHERE p.id::text = 'f0ecf463-c804-44de-9b51-7a1642eaccc3' AND i.author = 'Алина Гусакова' AND i.height > i.width;
  IF v_n <> 1 THEN
    RAISE WARNING '[1132] герой «Лавовые пещеры вулкана Горелый» не в 3:4 (найдено вертикальных: %)', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM place_gallery_photos g JOIN places p ON g.ark_id = p.ark_id
   WHERE p.id::text = 'f0ecf463-c804-44de-9b51-7a1642eaccc3' AND g.author = 'Алина Гусакова' AND g.position BETWEEN 1 AND 2 AND g.height > g.width;
  IF v_n <> 2 THEN
    RAISE WARNING '[1132] галерея «Лавовые пещеры вулкана Горелый»: в 3:4 % кадров из 2', v_n;
  END IF;
END $$;

COMMIT;
