-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1140: «Смотровая над Авачинской бухтой» — кадр Алины Гусаковой.
--
-- Владелец 02.10 прислал кадр с подписью «Смотровая 3 брата, автор Алина
-- Гусакова»: скамья-сердце на смотровой, внизу бухта и три скалы. Права и
-- порядок те же, что у всей серии (1115–1139): автор Алина Гусакова, `license`
-- не ставится, разрешение на публикацию — не лицензия. Размер — по образцу
-- 1129–1134: вертикальный 3:4, JPEG q72, герой 960x1280.
--
-- ── Какая из четырёх записей ──────────────────────────────────────────────
--
-- В миграции 094 четыре записи с «Три брата» в описании, и по репозиторию не
-- видно, какая живая. Проба 637 (публичный GET /api/places/<id>, 02.10):
--
--   0005d451  404   26fef61c  404   6292fc3b  404   — скрыты или слиты
--   60b06659  200  «Смотровая на обрыве над Авачинской бухтой» — ЖИВАЯ
--
-- Живая запись и взята. Скалы Три Брата (fd3feffa, снимок владельца 961) не
-- тронуты: это отдельная запись, а кадр здесь снят именно со смотровой.
-- Поиск /api/search по имени в тот же прогон ничего не вернул (семантика на
-- проде недоступна, `degraded`) — это не довод ни за, ни против.
--
-- ── Куда ложится ──────────────────────────────────────────────────────────
--
-- Героем: у вертикального кадра с одним предметом это его место, и правило
-- то же, что в 1120: встаёт поверх машинной картинки и скрейпа, а ручной
-- снимок (владельца, Викисклада, чужой) не вытесняется. Что стоит у записи
-- сейчас, проба не показала (ответ обрезан на описании) — поэтому есть запасной
-- ход: если героя занимает чужой ручной снимок, кадр уходит в галерею на
-- следующую свободную позицию. Повторный прогон кадр не дублирует.
--
-- Людей в кадре нет. Подпись — только то, что видно, без названий.
-- s3_url сбрасывается — байты увезёт cron-images-to-s3 (§4.1).
--
-- IDEMPOTENT

BEGIN;

-- ── Герой: только поверх снимка без ручного происхождения ───────────────
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок Алины Гусаковой: смотровая, скамья-сердце, бухта и скалы Три брата (миграция 1140)',
       'manual-upload',
       960,
       1280,
       'Алина Гусакова',
       'migrations/photos/1a217e3bdd6d1fffb23932c58b6b42056ec4b647675eeb997c81ed93a1dc4fab.jpg'
  FROM places p
 WHERE p.id::text = '60b06659-f636-43b7-8b18-0601d8744739'
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
       license    = NULL,
       license_url = NULL,
       source_url = NULL,
       s3_url     = NULL,
       s3_key     = EXCLUDED.s3_key,
       created_at = NOW()
 WHERE ai_route_images.model NOT IN ('wikimedia', 'manual-upload')
    OR ai_route_images.prompt = EXCLUDED.prompt;

-- ── Запасной ход: герой занят чужим ручным снимком — кадр в галерею ───────
-- Позиция — следующая свободная; строка Алины, уже лежащая в галерее, второй
-- раз не добавляется.
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       COALESCE((SELECT max(g.position) FROM place_gallery_photos g WHERE g.ark_id = p.ark_id), 0) + 1,
       NULL::bytea,
       'image/jpeg',
       720,
       960,
       'Сердце-скамья на смотровой, внизу бухта и скалы Три брата',
       'Алина Гусакова',
       'migrations/photos/b3ea265f616a2b447b9d6000e4c46af4b5fc8e55efe2135113ab4f1fab3f6083.jpg'
  FROM places p
 WHERE p.id::text = '60b06659-f636-43b7-8b18-0601d8744739'
   AND p.ark_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM ai_route_images i
                    WHERE i.route_id = p.ark_id AND i.author = 'Алина Гусакова')
   AND NOT EXISTS (SELECT 1 FROM place_gallery_photos g
                    WHERE g.ark_id = p.ark_id AND g.author = 'Алина Гусакова')
 LIMIT 1;

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_n int;
BEGIN
  SELECT (SELECT count(*) FROM ai_route_images i JOIN places p ON i.route_id = p.ark_id
           WHERE p.id::text = '60b06659-f636-43b7-8b18-0601d8744739' AND i.author = 'Алина Гусакова')
       + (SELECT count(*) FROM place_gallery_photos g JOIN places p ON g.ark_id = p.ark_id
           WHERE p.id::text = '60b06659-f636-43b7-8b18-0601d8744739' AND g.author = 'Алина Гусакова')
    INTO v_n;
  IF v_n <> 1 THEN
    RAISE WARNING '[1140] «Смотровая над Авачинской бухтой»: кадров Алины на карточке % вместо 1 (место не найдено или нет ark_id)', v_n;
  END IF;
END $$;

COMMIT;
