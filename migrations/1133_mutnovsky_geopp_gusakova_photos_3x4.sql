-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1133: «Мутновская ГеоЭС» — кадры Алины Гусаковой из 1125 переложены в 3:4.
--
-- Владелец 01.10: «остальные фото Алины тоже переделай в 3:4». Карточка
-- места показывает снимки в рамке во всю ширину и высотой 62% экрана — на
-- телефоне это почти 3:4, и полоса 16:9, которой 1125 их положила, там
-- режется до центральных 40% ширины: человек у края кадра пропадал.
-- Теперь кадр — вертикальный 3:4 из того же исходника (960x1280, у узкого
-- исходника — его родная ширина), JPEG q72. Подписи и порядок те же.
--
-- Только UPDATE строк, которые положила 1125: автор «Алина Гусакова», та же позиция.
-- Чужой снимок на той же позиции не тронется. s3_url сбрасывается — новые
-- байты увезёт cron-images-to-s3 (§4.1); created_at = NOW() меняет адрес
-- снимка (?v=), и телефон не покажет старый кадр из кэша.
--
-- IDEMPOTENT

BEGIN;

-- ── Герой ─────────────────────────────────────────────────────────────────
UPDATE ai_route_images i
   SET image_data = NULL, s3_key = 'migrations/photos/7f37bf442374746fe1b009914932cdc417bcf2b3639db475c381a218b78dfb58.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = '84f12e37-fd15-44e7-b60e-063f176d059e'
   AND i.route_id = p.ark_id
   AND i.author = 'Алина Гусакова';

-- ── Галерея, позиция 1 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/e32021dcca02b4c2fd3862c2a8e0864b81a6fe661b1a43e672bdc7ae22c84d46.jpg',
       mime_type = 'image/jpeg', width = 720, height = 960,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = '84f12e37-fd15-44e7-b60e-063f176d059e'
   AND g.ark_id = p.ark_id
   AND g.position = 1
   AND g.author = 'Алина Гусакова';

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM ai_route_images i JOIN places p ON i.route_id = p.ark_id
   WHERE p.id::text = '84f12e37-fd15-44e7-b60e-063f176d059e' AND i.author = 'Алина Гусакова' AND i.height > i.width;
  IF v_n <> 1 THEN
    RAISE WARNING '[1133] герой «Мутновская ГеоЭС» не в 3:4 (найдено вертикальных: %)', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM place_gallery_photos g JOIN places p ON g.ark_id = p.ark_id
   WHERE p.id::text = '84f12e37-fd15-44e7-b60e-063f176d059e' AND g.author = 'Алина Гусакова' AND g.position BETWEEN 1 AND 1 AND g.height > g.width;
  IF v_n <> 1 THEN
    RAISE WARNING '[1133] галерея «Мутновская ГеоЭС»: в 3:4 % кадров из 1', v_n;
  END IF;
END $$;

COMMIT;
