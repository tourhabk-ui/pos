-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1131: «Вилючинский перевал» — кадры Алины Гусаковой из 1121 переложены в 3:4.
--
-- Владелец 01.10: «остальные фото Алины тоже переделай в 3:4». Карточка
-- места показывает снимки в рамке во всю ширину и высотой 62% экрана — на
-- телефоне это почти 3:4, и полоса 16:9, которой 1121 их положила, там
-- режется до центральных 40% ширины: человек у края кадра пропадал.
-- Теперь кадр — вертикальный 3:4 из того же исходника (960x1280, у узкого
-- исходника — его родная ширина), JPEG q72. Подписи и порядок те же.
--
-- Только UPDATE строк, которые положила 1121: автор «Алина Гусакова», та же позиция.
-- Чужой снимок на той же позиции не тронется. s3_url сбрасывается — новые
-- байты увезёт cron-images-to-s3 (§4.1); created_at = NOW() меняет адрес
-- снимка (?v=), и телефон не покажет старый кадр из кэша.
--
-- IDEMPOTENT

BEGIN;

-- ── Галерея, позиция 1 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/1904df006534bae8115bfccce1eaaafec315bdf98bcd2a643af83276b7850b42.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = '8bad8fe6-c7ec-4403-b956-948706649ca8'
   AND g.ark_id = p.ark_id
   AND g.position = 1
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 2 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/2b65b4418a05fc15a846061aa50adfa053a44d6a521ee79fa73b18ed84872740.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = '8bad8fe6-c7ec-4403-b956-948706649ca8'
   AND g.ark_id = p.ark_id
   AND g.position = 2
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 3 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/79f48280dd16a81ff3affc3cf936a2abdec667b236e62c0d0af0bec6ef68e2bb.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = '8bad8fe6-c7ec-4403-b956-948706649ca8'
   AND g.ark_id = p.ark_id
   AND g.position = 3
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 4 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/b7d591b06bf93bfc83347f1c5fdc459d6b6c2a1e94492089bdc61c2ca53d35bf.jpg',
       mime_type = 'image/jpeg', width = 960, height = 1280,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = '8bad8fe6-c7ec-4403-b956-948706649ca8'
   AND g.ark_id = p.ark_id
   AND g.position = 4
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 5 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/3918b7dfebbfc10e876696cbbd0cc8e48ee8645ba04111d363854277b945dd2b.jpg',
       mime_type = 'image/jpeg', width = 723, height = 964,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = '8bad8fe6-c7ec-4403-b956-948706649ca8'
   AND g.ark_id = p.ark_id
   AND g.position = 5
   AND g.author = 'Алина Гусакова';

-- ── Галерея, позиция 6 ──────────────────────────────────────────────────
UPDATE place_gallery_photos g
   SET image_data = NULL, s3_key = 'migrations/photos/a2f23a75e513affeafc993609ae42b2c3c01b8fe8eb9dee66e4c3005e27f3bac.jpg',
       mime_type = 'image/jpeg', width = 723, height = 964,
       s3_url = NULL, created_at = NOW()
  FROM places p
 WHERE p.id::text = '8bad8fe6-c7ec-4403-b956-948706649ca8'
   AND g.ark_id = p.ark_id
   AND g.position = 6
   AND g.author = 'Алина Гусакова';

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM place_gallery_photos g JOIN places p ON g.ark_id = p.ark_id
   WHERE p.id::text = '8bad8fe6-c7ec-4403-b956-948706649ca8' AND g.author = 'Алина Гусакова' AND g.position BETWEEN 1 AND 6 AND g.height > g.width;
  IF v_n <> 6 THEN
    RAISE WARNING '[1131] галерея «Вилючинский перевал»: в 3:4 % кадров из 6', v_n;
  END IF;
END $$;

COMMIT;
