-- 1515: Зеленовские озерки — кадр «Раздолья Камчатки» снят, зимнее озеро первым, бассейны в галерею
-- Created: 2026-11-26
--
-- ── Почему ────────────────────────────────────────────────────────────────
--
-- Владелец 26.11, посмотрев карточку после 1513: «вернее 3 чужой не ставим»,
-- «1 пусть будет зимнее озеро», «людей сможем убрать?», затем: «на месте
-- зеленовских озерков фото Раздолья камчатки».
--
-- ── Что меняется ──────────────────────────────────────────────────────────
--
--   1. Обложка тура «Лагуны Экспедиции» «Зеленовские озерки», которую 1436
--      поставила первым кадром места, снимается с карточки: на ней «Раздолье
--      Камчатки», а не озерки. Строка не удаляется — прячется причиной
--      (hidden_reason, 1263), как прячут кадр без согласия; у тура обложка своя
--      и этой миграцией не трогается.
--   2. Зимний снимок озера (Андрей Запорожец, 1513) встаёт первым кадром
--      карточки. Остальные кадры идут следом в прежнем порядке между собой.
--   3. Последним ложится снимок бассейнов того же автора. На исходном кадре в
--      бассейнах слева и справа сидели люди; кадр обрезан по середине
--      (413×540 из 720×540), ничего не дорисовано.
--
-- Снимок со знаком topkam.ru — чужой и не ставится, как и в 1513.
--
-- ── Метка версии ──────────────────────────────────────────────────────────
--
-- Адрес кадра — ark_id и позиция, раздача отдаёт его «неизменным на год», а
-- версию адреса даёт created_at (lib/places/place-detail). Два кадра 1513
-- записаны одной транзакцией, метка у них одна: после перестановки адрес
-- «позиция 3 с той же меткой» отдавал бы летнее озеро тем, у кого под ним уже
-- лежит зимнее. Поэтому переставленным кадрам метка обновляется.
--
-- ── Повтор ────────────────────────────────────────────────────────────────
--
-- Зимний кадр уже первый — перестановки нет, метки не трогаются. Кадр
-- бассейнов с тем же ключом уже есть — строки нет. Место, партнёр или зимний
-- кадр не найдены — ничего не делается, и это названо.
--
-- Объект бассейнов залит media-to-s3 (прогон 30) предыдущим PR и прочитан
-- обратно. Размеры — самого файла.
--
-- IDEMPOTENT

BEGIN;

-- ── 1. Кадр «Раздолья» — с карточки места ─────────────────────────────────
UPDATE place_gallery_photos g
   SET hidden_reason = 'на кадре «Раздолье Камчатки», а не Зеленовские озерки (владелец 26.11) — обложка тура «Лагуны Экспедиции» остаётся у тура'
  FROM places p
 WHERE p.ark_id = g.ark_id
   AND p.slug = 'zelenovskie-ozerki' AND p.merged_into_id IS NULL
   AND g.s3_key = 'photos/laguna-expedition/zelenovskie-ozerki-cover.jpg'
   AND g.hidden_reason IS NULL;

-- ── 2. Зимнее озеро — первым ──────────────────────────────────────────────
DO $$
DECLARE
  v_ark uuid;
  v_winter_pos int;
BEGIN
  SELECT p.ark_id INTO v_ark
    FROM places p
   WHERE p.slug = 'zelenovskie-ozerki' AND p.merged_into_id IS NULL AND p.ark_id IS NOT NULL;
  IF v_ark IS NULL THEN
    RAISE WARNING '[1515] место zelenovskie-ozerki не найдено — порядок не менялся';
    RETURN;
  END IF;

  SELECT g.position INTO v_winter_pos
    FROM place_gallery_photos g
   WHERE g.ark_id = v_ark AND g.s3_key = 'photos/zaporozhets/zelenovskie-ozerki-ozero-zimoy.jpg';
  IF v_winter_pos IS NULL THEN
    RAISE WARNING '[1515] зимнего снимка озера у места нет — порядок не менялся';
    RETURN;
  END IF;
  IF v_winter_pos = (SELECT min(g.position) FROM place_gallery_photos g WHERE g.ark_id = v_ark) THEN
    RAISE NOTICE '[1515] зимний снимок уже первый — порядок не менялся';
    RETURN;
  END IF;

  -- Индекс (ark_id, position) уникален и проверяется построчно: сначала все
  -- кадры места уходят на временные номера, потом получают новые.
  CREATE TEMP TABLE _order1515 ON COMMIT DROP AS
    SELECT g.id,
           g.position AS old_pos,
           row_number() OVER (
             ORDER BY (g.s3_key = 'photos/zaporozhets/zelenovskie-ozerki-ozero-zimoy.jpg') DESC NULLS LAST, g.position
           )::int AS new_pos
      FROM place_gallery_photos g
     WHERE g.ark_id = v_ark;

  UPDATE place_gallery_photos g
     SET position = g.position + 100000
   WHERE g.ark_id = v_ark;

  UPDATE place_gallery_photos g
     SET position = o.new_pos,
         created_at = CASE WHEN o.new_pos <> o.old_pos THEN NOW() ELSE g.created_at END
    FROM _order1515 o
   WHERE g.id = o.id;

  RAISE NOTICE '[1515] зимний снимок озера поставлен первым, кадров у места: %',
    (SELECT count(*) FROM _order1515);
END $$;

-- ── 3. Снимок бассейнов ───────────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height,
                                  caption, author, license, license_url, source_url, s3_key, partner_id)
SELECT p.ark_id,
       COALESCE((SELECT max(g.position) FROM place_gallery_photos g WHERE g.ark_id = p.ark_id), 0) + 1,
       NULL::bytea, 'image/jpeg', 413, 540,
       'Бассейны на Зеленовских озерках', pa.name, NULL::text, NULL::text, NULL::text,
       'photos/zaporozhets/zelenovskie-ozerki-basseyny.jpg', pa.id
  FROM places p
  JOIN partners pa ON pa.slug = 'andrey-zaporozhets'
 WHERE p.slug = 'zelenovskie-ozerki' AND p.merged_into_id IS NULL AND p.ark_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM place_gallery_photos g
                    WHERE g.ark_id = p.ark_id
                      AND g.s3_key = 'photos/zaporozhets/zelenovskie-ozerki-basseyny.jpg')
ON CONFLICT (ark_id, position) DO NOTHING;

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_first text;
  v_pools int;
  v_razdolye int;
BEGIN
  SELECT count(*) INTO v_razdolye
    FROM place_gallery_photos g
    JOIN places p ON p.ark_id = g.ark_id
   WHERE p.slug = 'zelenovskie-ozerki' AND p.merged_into_id IS NULL
     AND g.s3_key = 'photos/laguna-expedition/zelenovskie-ozerki-cover.jpg'
     AND g.hidden_reason IS NULL;
  IF v_razdolye > 0 THEN
    RAISE WARNING '[1515] кадр «Раздолья» всё ещё на карточке места';
  END IF;

  SELECT g.s3_key INTO v_first
    FROM place_gallery_photos g
    JOIN places p ON p.ark_id = g.ark_id
   WHERE p.slug = 'zelenovskie-ozerki' AND p.merged_into_id IS NULL
   ORDER BY g.position
   LIMIT 1;
  SELECT count(*) INTO v_pools
    FROM place_gallery_photos g
    JOIN places p ON p.ark_id = g.ark_id
   WHERE p.slug = 'zelenovskie-ozerki' AND p.merged_into_id IS NULL
     AND g.s3_key = 'photos/zaporozhets/zelenovskie-ozerki-basseyny.jpg';

  IF v_first IS DISTINCT FROM 'photos/zaporozhets/zelenovskie-ozerki-ozero-zimoy.jpg' THEN
    RAISE WARNING '[1515] первый кадр места — не зимнее озеро: %', COALESCE(v_first, 'кадров нет');
  END IF;
  IF v_pools = 0 THEN
    RAISE WARNING '[1515] снимок бассейнов на карточку не лёг (нет места или карточки автора)';
  ELSE
    RAISE NOTICE '[1515] снимок бассейнов на карточке места';
  END IF;
END $$;

COMMIT;

-- Откат (порядок кадров и снимки — не данные места):
-- UPDATE place_gallery_photos SET hidden_reason = NULL
--  WHERE s3_key = 'photos/laguna-expedition/zelenovskie-ozerki-cover.jpg'
--    AND hidden_reason LIKE 'на кадре «Раздолье Камчатки»%';
-- DELETE FROM place_gallery_photos
--  WHERE s3_key = 'photos/zaporozhets/zelenovskie-ozerki-basseyny.jpg';
-- Прежний порядок: зимний кадр — на позицию после летнего тем же приёмом
-- (временные номера, затем новые), с обновлением created_at у переставленных.
