-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1007: «Озеро Толмачёва» — семь кадров владельца: герой и галерея.
--
-- ── Что прислано ──────────────────────────────────────────────────────────
--
-- 23.09 владелец прислал семь кадров одной подписью: «Озеро Толмачева».
-- Все семь сняты с одного берега при разной погоде: снежная вершина над
-- водой, купол в снегу, синее небо над стлаником, отмель с зубчатой грядой,
-- широкая вода, низкие облака. Шесть публикуются, один — нет (ниже, почему).
--
-- ── Куда ──────────────────────────────────────────────────────────────────
--
-- Мест с этим именем в миграциях было четыре (653): «Озеро Толмачёва»,
-- «Озеро Толмачево», «Озеро Толмачева и озеро Маар», «На каяках по озеру
-- Толмачево». Миграция 881 сливала не их, а одноимённые МАРШРУТЫ
-- (kamchatka_routes), и класть снимок по её id нельзя: снимок вешается на
-- places.ark_id. Какая запись живая — спросила проба 562 (place-audit и
-- карточки кандидатов). Ответ прода:
--
--   2512ca75  «Озеро Толмачева и озеро Маар»  видимая, не слитая, без фото  ← сюда
--   c8d6a48e  «Озеро Толмачево»               СЛИТА в 2512ca75
--   9eba9524  «Озеро Толмачёва»               СКРЫТА (не слита; координата у
--                                             неё — координата вулкана
--                                             Толмачёва, 52.552/157.733)
--   04e427c5  «Толмачёва»                     ВУЛКАН, другое место
--
-- Кладётся на Озеро Толмачева и озеро Маар (2512ca75-547c-4348-a219-86c7e6937940): это единственная живая карточка озера, у
-- неё 52.609/157.592 — в двух километрах от озера по OpenStreetMap, рядом
-- «Маар Медвежья чаша» (3 км) и вулкан Толмачёва (11 км). Скрытая тёзка не
-- трогается: почему её скрыли, в миграциях не записано, и снимок на скрытой
-- карточке никто не увидит.
--
-- ── Попутно: координата в тексте против координаты записи ─────────────────
--
-- Описание этой же карточки заканчивается фразой «Координаты для навигатора:
-- 52.92°N, 157.12°E». Запись стоит на 52.61/157.59 — это в СОРОКА с лишним
-- километрах от того, что текст предлагает вбить в навигатор. Цифра пришла
-- из партии 096: там ОДНА и та же пара 52.92/157.12 приписана всем четырём
-- записям Толмачёва разом, включая ту, где текст сам признаёт свою
-- координату ошибочной, — то есть это не измерение, а генерация.
--
-- Правится только эта фраза, и только пока она стоит в тексте дословно: всё
-- остальное описание (кордон, разрешения, глубины) проверить нечем, и оно
-- остаётся как есть. Фраза «для навигатора» — не описание, а инструкция, и
-- инструкция, уводящая на сорок километров, опаснее её отсутствия (тот же
-- довод, что в 1002).
--
-- ── Кадр, который НЕ публикуется ──────────────────────────────────────────
--
-- На четвёртом кадре у кромки воды сидит человек — спиной, далеко, но это
-- человек, и согласия на публикацию своего изображения он не давал.
-- Владелец о нём не говорил. Тот же разбор, что в миграциях 967 и 1002: в
-- кадре его быть не должно, а вырезать фигуру, не тронув берег, здесь
-- нельзя — она стоит посреди композиции. Кадр остаётся у владельца.
--
-- ── Автор ─────────────────────────────────────────────────────────────────
--
-- НЕ ЗАПИСАН, и это намеренно. Прежние снимки владелец подписывал сам
-- («фото мое», «мое старое фото», «фото Андрея Склярова») — здесь подписи
-- нет, только имя озера. Приписать авторство по привычке значило бы записать
-- в базу то, чего никто не говорил (§4.0): author = NULL — «не знаю», а не
-- «ничей». Как только владелец назовёт автора, отдельная миграция впишет имя
-- в обе таблицы — снимки от этого не переезжают.
--
-- Следствие для ON CONFLICT у героя: неподписанный кадр НЕ вытесняет
-- подписанный (правило 1001: неподписанное уступает подписанному, а не
-- наоборот). Машинную картинку, картинку без автора и свой прежний кадр —
-- вытесняет.
--
-- ── Обрезка ───────────────────────────────────────────────────────────────
--
-- Окно 16:9 полной ширины (1280x720 из 1280x853), смещение сверху у каждого
-- кадра выбрано по предмету, а не по умолчанию (урок 958: cover/attention
-- уводит окно в светлое небо): 100 px у героя — вершина остаётся, воды
-- больше; 133 (максимум) там, где предмет у нижней кромки; 60-80 у кадров с
-- горами посередине. Содержимое не менялось, только срез и пережатие.
--
-- ── Как ложится ───────────────────────────────────────────────────────────
--
-- Герой — ai_route_images (одна строка на место, ON CONFLICT (route_id)).
-- Галерея — place_gallery_photos (968), позиции 1-5, ON CONFLICT
-- (ark_id, position): повтор не плодит строк.
--
-- Байты пишутся в базу, а не в хранилище — миграция в S3 ходить не может;
-- ночной cron-images-to-s3 увезёт их следующим прогоном (правило 18.09).
-- s3_url/s3_key обнуляются: старый объект этим байтам не соответствует.
--
-- IDEMPOTENT

BEGIN;

-- ── 0. Координата «для навигатора», не совпадающая с координатой записи ───
UPDATE places
   SET description = regexp_replace(description, '\s*Координаты для навигатора: 52\.92°N, 157\.12°E\.?\s*$', ''),
       updated_at = NOW()
 WHERE id::text = '2512ca75-547c-4348-a219-86c7e6937940'
   AND description LIKE '%Координаты для навигатора: 52.92°N, 157.12°E%';

-- ── Герой ─────────────────────────────────────────────────────────────────
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: озеро Толмачёва, снежная вершина над водой (миграция 1007)',
       'manual-upload',
       1280,
       720,
       NULL,
       'migrations/photos/f517dc0ad0daca916fe7a67006a92a53b4f52c7981b379db8af2903ab216484c.jpg'
  FROM places p
 WHERE p.id::text = '2512ca75-547c-4348-a219-86c7e6937940'
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
 WHERE ai_route_images.model NOT IN ('wikimedia', 'manual-upload')
    OR ai_route_images.author IS NULL
    OR ai_route_images.prompt = 'снимок владельца: озеро Толмачёва, снежная вершина над водой (миграция 1007)';

-- ── Галерея 1: Заснеженный купол над тёмным склоном, вид с воды ──
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       1,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Заснеженный купол над тёмным склоном, вид с воды',
       NULL,
       'migrations/photos/9c573d9cf5b6bc2aadda98e24c1a65e5ac4502c6e60e0706a57d346cb02761c1.jpg'
  FROM places p
 WHERE p.id::text = '2512ca75-547c-4348-a219-86c7e6937940'
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

-- ── Галерея 2: Кедровый стланик на берегу, дальний хребет под облаками ──
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       2,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Кедровый стланик на берегу, дальний хребет под облаками',
       NULL,
       'migrations/photos/0f47b90912a5d7990ad4ff58f2a46f08a825e22a3a74f0e37f41c7e75bef8a0e.jpg'
  FROM places p
 WHERE p.id::text = '2512ca75-547c-4348-a219-86c7e6937940'
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

-- ── Галерея 3: Отмель и зубчатая гряда на дальнем берегу ──
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       3,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Отмель и зубчатая гряда на дальнем берегу',
       NULL,
       'migrations/photos/3aa833ce843057ea975e2b3bd4ac41b58c3e8aa15575fdd8c15f132655ab3027.jpg'
  FROM places p
 WHERE p.id::text = '2512ca75-547c-4348-a219-86c7e6937940'
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

-- ── Галерея 4: Широкая вода, дальний берег в облаках ──
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       4,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Широкая вода, дальний берег в облаках',
       NULL,
       'migrations/photos/ed47c24ce0b787e363c9162f3857848bcab6a50069610724b9ee3015d63119d9.jpg'
  FROM places p
 WHERE p.id::text = '2512ca75-547c-4348-a219-86c7e6937940'
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

-- ── Галерея 5: Низкие облака над берегом, снег на вершине ──
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       5,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Низкие облака над берегом, снег на вершине',
       NULL,
       'migrations/photos/8ad867b2d90ea76dfebf6bceae80c5be4702a6131f50c1e809fe1f8661801f36.jpg'
  FROM places p
 WHERE p.id::text = '2512ca75-547c-4348-a219-86c7e6937940'
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

-- ── Отказ называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_ark     uuid;
  v_visible boolean;
  v_merged  uuid;
  v_prompt  text;
  v_gallery int;
BEGIN
  SELECT ark_id, is_visible, merged_into_id INTO v_ark, v_visible, v_merged
    FROM places WHERE id::text = '2512ca75-547c-4348-a219-86c7e6937940';

  IF v_ark IS NULL THEN
    RAISE WARNING '[1007] записи «Озеро Толмачева и озеро Маар» (2512ca75-547c-4348-a219-86c7e6937940) нет или у неё нет ark_id — снимки вешать некуда';
    RETURN;
  END IF;

  IF v_visible IS DISTINCT FROM true OR v_merged IS NOT NULL THEN
    RAISE WARNING '[1007] «Озеро Толмачева и озеро Маар» скрыта или слита — снимки легли туда, где карточка их не покажет';
  END IF;

  IF EXISTS (SELECT 1 FROM places WHERE id::text = '2512ca75-547c-4348-a219-86c7e6937940' AND description LIKE '%Координаты для навигатора: 52.92%') THEN
    RAISE WARNING '[1007] фраза с чужой координатой «для навигатора» ОСТАЛАСЬ в описании «Озеро Толмачева и озеро Маар»';
  END IF;

  SELECT prompt INTO v_prompt FROM ai_route_images WHERE route_id = v_ark;
  IF v_prompt IS DISTINCT FROM 'снимок владельца: озеро Толмачёва, снежная вершина над водой (миграция 1007)' THEN
    RAISE WARNING '[1007] герой «Озеро Толмачева и озеро Маар» НЕ заменён: на месте остался подписанный снимок (%)', v_prompt;
  END IF;

  SELECT COUNT(*) INTO v_gallery FROM place_gallery_photos WHERE ark_id = v_ark AND position BETWEEN 1 AND 5;
  IF v_gallery <> 5 THEN
    RAISE WARNING '[1007] в галерее «Озеро Толмачева и озеро Маар» % кадров из 5', v_gallery;
  END IF;
END $$;

COMMIT;
