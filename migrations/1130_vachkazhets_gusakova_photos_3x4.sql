-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1130: «Вачкажец» — кадры Алины Гусаковой из 1120 переложены в 3:4.
--
-- Владелец 01.10: «остальные фото Алины тоже переделай в 3:4». Карточка
-- места показывает снимки в рамке во всю ширину и высотой 62% экрана — на
-- телефоне это почти 3:4, и полоса 16:9, которой 1120 их положила, там
-- режется до центральных 40% ширины: человек у края кадра пропадал.
-- Теперь кадр — вертикальный 3:4 из того же исходника (960x1280, у узкого
-- исходника — его родная ширина), JPEG q72. Подписи и порядок те же.
--
-- Только UPDATE строк, которые положила 1120: автор «Алина Гусакова», та же позиция.
-- Чужой снимок на той же позиции не тронется. s3_url сбрасывается — новые
-- байты увезёт cron-images-to-s3 (§4.1); created_at = NOW() меняет адрес
-- снимка (?v=), и телефон не покажет старый кадр из кэша.
--
-- IDEMPOTENT

BEGIN;

-- ── Галерея, позиция 1 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/08958e37d8d8b5e59cab561b2e59484899a3056552ac60dd53ac7563818b54a3.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
   AND g.ark_id = p.ark_id
   AND g.position = 1
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 2 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/6438b8ee2755e6f9115ea1d235fa421e76abc119921c2abceeea5ac4c856ed3c.jpg',
       mime_type = 'image/jpeg', width = 720, height = 960,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
   AND g.ark_id = p.ark_id
   AND g.position = 2
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 3 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/862d0e9001dd8f4e3838016d6b6afbf8837223982af42cc6daf51b8c21e0051a.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
   AND g.ark_id = p.ark_id
   AND g.position = 3
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 4 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/c608899d4e6bd3e6df760d478d55104181833b5b9a6a081ed751ccf0f8c2ec8c.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
   AND g.ark_id = p.ark_id
   AND g.position = 4
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 5 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/25d2a1e4b78b93b73393109807a48457e8c5a70947c6368b31c3ffb02c4c6c6e.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
   AND g.ark_id = p.ark_id
   AND g.position = 5
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 6 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/58e72afbfd6ddea7ad6139eb16d1213cd6d41c3b277a1ca2c2ca83b57f50fdd2.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
   AND g.ark_id = p.ark_id
   AND g.position = 6
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 7 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/8b71983bd61d2e81ac5561633c2afad0199b351c4d97348e5dbef8b3b7e70453.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
   AND g.ark_id = p.ark_id
   AND g.position = 7
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 8 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/1a02e797f978da8d4c114aee09fc25b5dba857de848a94a58e63cdd97743595b.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
   AND g.ark_id = p.ark_id
   AND g.position = 8
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 9 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/9c257927729b9058691b75d0cd191188f7616fc6355bb87e2310621ed2f1312b.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
   AND g.ark_id = p.ark_id
   AND g.position = 9
   AND g.author = 'Алина Гусакова';

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM place_gallery_photos g JOIN places p ON g.ark_id = p.ark_id
   WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe' AND g.author = 'Алина Гусакова' AND g.position BETWEEN 1 AND 9 AND g.height > g.width;
  IF v_n <> 9 THEN
    RAISE WARNING '[1130] галерея «Вачкажец»: в 3:4 % кадров из 9', v_n;
  END IF;
END $$;

COMMIT;
