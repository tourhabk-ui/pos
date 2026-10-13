-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1134: «Дачные горячие источники» — кадры Алины Гусаковой из 1126 переложены в 3:4.
--
-- Владелец 01.10: «остальные фото Алины тоже переделай в 3:4». Карточка
-- места показывает снимки в рамке во всю ширину и высотой 62% экрана — на
-- телефоне это почти 3:4, и полоса 16:9, которой 1126 их положила, там
-- режется до центральных 40% ширины: человек у края кадра пропадал.
-- Теперь кадр — вертикальный 3:4 из того же исходника (960x1280, у узкого
-- исходника — его родная ширина), JPEG q72. Подписи и порядок те же.
--
-- Только UPDATE строк, которые положила 1126: автор «Алина Гусакова», та же позиция.
-- Чужой снимок на той же позиции не тронется. s3_url сбрасывается — новые
-- байты увезёт cron-images-to-s3 (§4.1); created_at = NOW() меняет адрес
-- снимка (?v=), и телефон не покажет старый кадр из кэша.
--
-- IDEMPOTENT

BEGIN;

-- ── Галерея, позиция 1 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/9820f661b331842c2e117263745b563b627b274f472768f56226e972cad9e3fb.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = '2bf92082-0daf-4770-8031-a51c0f355be8'
   AND g.ark_id = p.ark_id
   AND g.position = 1
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 2 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/ceb659a3c7909f47eacfdffb2f0bb555672a5877360ad863ae72e626e6978dce.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = '2bf92082-0daf-4770-8031-a51c0f355be8'
   AND g.ark_id = p.ark_id
   AND g.position = 2
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 3 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/61c25edd959d5bd70e52d5dcb8ca75b98daf604b3fab9f28d9a9378849cb8371.jpg',
       mime_type = 'image/jpeg', width = 690, height = 920,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = '2bf92082-0daf-4770-8031-a51c0f355be8'
   AND g.ark_id = p.ark_id
   AND g.position = 3
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 4 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/1c8f4da5acbcbb65cf123933247e00cd612c271d498541981f79ad17f4b0ddda.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = '2bf92082-0daf-4770-8031-a51c0f355be8'
   AND g.ark_id = p.ark_id
   AND g.position = 4
   AND g.author = 'Алина Гусакова';

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM place_gallery_photos g JOIN places p ON g.ark_id = p.ark_id
   WHERE p.id::text = '2bf92082-0daf-4770-8031-a51c0f355be8' AND g.author = 'Алина Гусакова' AND g.position BETWEEN 1 AND 4 AND g.height > g.width;
  IF v_n <> 4 THEN
    RAISE WARNING '[1134] галерея «Дачные горячие источники»: в 3:4 % кадров из 4', v_n;
  END IF;
END $$;

COMMIT;
