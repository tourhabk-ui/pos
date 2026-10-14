-- 1241: снимки Кроноцкого заповедника — главный кадр карточки и галерея.
-- Created: 2026-10-14
--
-- Владелец 14.10: «Кроноцкий заповедник нужно завести и сделать страницу
-- описания, это красивое место» (место — миграция 1240) и «в летописи сделай
-- красивую страницу». Своих снимков у платформы нет ни у заповедника, ни у
-- мест внутри него — даже у Долины гейзеров (проба 803).
--
-- ── Откуда снимки ─────────────────────────────────────────────────────────
--
-- Wikimedia Commons, категория «Kronotsky Nature Reserve» и её подкатегории.
-- Автор и лицензия каждого файла сняты из extmetadata 14.10 (проба по
-- категории и названиям): только свободные лицензии с названным автором —
-- без автора снимок не показывается вовсе (lib/images/origin.ts). Превью
-- скачаны раннером (operator-photos), пережаты, метаданные сняты; в хранилище
-- лежат под photos/kronotsky/ — залиты и прочитаны обратно (media-to-s3,
-- прогон 3) ДО этой миграции, иначе карточка показала бы битый снимок.
--
-- Подписи — названия файлов у автора, английские переведены. Ничего сверх
-- них: «над Кроноцким озером» и подобное не дописывается, если автор этого
-- не сказал (§4.0).
--
-- Главный кадр ложится, только если у места нет показываемого снимка или
-- это повтор этой же миграции — чужое фото (своё фото владельца, ручная
-- загрузка) не затирается. Галерея — ON CONFLICT DO NOTHING по позиции.
--
-- IDEMPOTENT

BEGIN;

INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height,
                             author, license, license_url, source_url, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'Wikimedia Commons: «Кроноцкая в шляпе» (миграция 1241)',
       'wikimedia',
       1920,
       1280,
       'Malupasic',
       'CC BY-SA 4.0',
       'https://creativecommons.org/licenses/by-sa/4.0',
       'https://commons.wikimedia.org/wiki/File:%D0%9A%D1%80%D0%BE%D0%BD%D0%BE%D1%86%D0%BA%D0%B0%D1%8F_%D0%B2_%D1%88%D0%BB%D1%8F%D0%BF%D0%B5.jpg',
       'photos/kronotsky/kronotskaya-v-shlyape.jpg'
  FROM places p
 WHERE p.id::text = '4f1217e7-31a4-4d21-bc98-3d46aaba122e'
   AND p.ark_id IS NOT NULL
 LIMIT 1
ON CONFLICT (route_id) DO UPDATE
   SET image_data  = EXCLUDED.image_data,
       mime_type   = EXCLUDED.mime_type,
       prompt      = EXCLUDED.prompt,
       model       = EXCLUDED.model,
       width       = EXCLUDED.width,
       height      = EXCLUDED.height,
       author      = EXCLUDED.author,
       license     = EXCLUDED.license,
       license_url = EXCLUDED.license_url,
       source_url  = EXCLUDED.source_url,
       s3_url      = NULL,
       s3_key      = EXCLUDED.s3_key,
       created_at  = NOW()
 WHERE ai_route_images.model NOT IN ('wikimedia', 'manual-upload')
    OR ai_route_images.prompt = EXCLUDED.prompt;

WITH shots(position, width, height, caption, author, license, license_url, source_url, s3_key) AS (
  VALUES
    (1, 1600, 1067, 'Кроноцкая сопка с залива у низовий Унаны', 'Malupasic', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%9A%D1%80%D0%BE%D0%BD%D0%BE%D1%86%D0%BA%D0%B0%D1%8F_%D1%81%D0%BE%D0%BF%D0%BA%D0%B0_%D1%81_%D0%B7%D0%B0%D0%BB%D0%B8%D0%B2%D0%B0_%D1%83_%D0%BD%D0%B8%D0%B7%D0%BE%D0%B2%D0%B8%D0%B9_%D0%A3%D0%BD%D0%B0%D0%BD%D1%8B.jpg',
     'photos/kronotsky/kronotskaya-s-zaliva-unana.jpg'),
    (2, 1280, 960, 'Кальдера Узона', 'Rost.galis', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%9A%D0%B0%D0%BB%D1%8C%D0%B4%D0%B5%D1%80%D0%B0_%D0%A3%D0%B7%D0%BE%D0%BD%D0%B0.jpg',
     'photos/kronotsky/kaldera-uzona.jpg'),
    (3, 1280, 848, 'Долина гейзеров', 'Ushakovm83', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%94%D0%BE%D0%BB%D0%B8%D0%BD%D0%B0_%D0%93%D0%B5%D0%B9%D0%B7%D0%B5%D1%80%D0%BE%D0%B2.jpg',
     'photos/kronotsky/dolina-gejzerov.jpg'),
    (4, 1280, 960, 'Чудо Долины', 'Rost.galis', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%A7%D1%83%D0%B4%D0%BE_%D0%94%D0%BE%D0%BB%D0%B8%D0%BD%D1%8B.jpg',
     'photos/kronotsky/chudo-doliny.jpg'),
    (5, 1280, 939, 'Туристы в долине реки Гейзерной у гейзера Большой', 'Rost.galis', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%A2%D1%83%D1%80%D0%B8%D1%81%D1%82%D1%8B_%D0%B2_%D0%B4%D0%BE%D0%BB%D0%B8%D0%BD%D0%B5_%D1%80%D0%B5%D0%BA%D0%B8_%D0%93%D0%B5%D0%B9%D0%B7%D0%B5%D1%80%D0%BD%D0%BE%D0%B9_%D1%83_%D0%B3%D0%B5%D0%B9%D0%B7%D0%B5%D1%80%D0%B0_%D0%91%D0%BE%D0%BB%D1%8C%D1%88%D0%BE%D0%B9.jpg',
     'photos/kronotsky/turisty-u-gejzera-bolshoj.jpg'),
    (6, 900, 590, 'Кроноцкое озеро', 'Игорь Шпиленок', 'CC BY-SA 3.0',
     'https://creativecommons.org/licenses/by-sa/3.0',
     'https://commons.wikimedia.org/wiki/File:Lake_Kronotzkoe.jpg',
     'photos/kronotsky/lake-kronotzkoe.jpg'),
    (7, 900, 513, 'Кроноцкая сопка', 'Игорь Шпиленок', 'CC BY-SA 3.0',
     'https://creativecommons.org/licenses/by-sa/3.0',
     'https://commons.wikimedia.org/wiki/File:Kronotsky_volcano.jpg',
     'photos/kronotsky/kronotsky-volcano.jpg')
)
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height,
                                  caption, author, license, license_url, source_url, s3_key)
SELECT p.ark_id, s.position, NULL::bytea, 'image/jpeg', s.width, s.height,
       s.caption, s.author, s.license, s.license_url, s.source_url, s.s3_key
  FROM shots s
  JOIN places p ON p.id::text = '4f1217e7-31a4-4d21-bc98-3d46aaba122e'
 WHERE p.ark_id IS NOT NULL
ON CONFLICT (ark_id, position) DO NOTHING;

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_hero text;
  v_gallery int;
BEGIN
  SELECT i.s3_key INTO v_hero
    FROM ai_route_images i JOIN places p ON i.route_id = p.ark_id
   WHERE p.id::text = '4f1217e7-31a4-4d21-bc98-3d46aaba122e';
  SELECT count(*) INTO v_gallery
    FROM place_gallery_photos g JOIN places p ON g.ark_id = p.ark_id
   WHERE p.id::text = '4f1217e7-31a4-4d21-bc98-3d46aaba122e';
  IF v_hero IS DISTINCT FROM 'photos/kronotsky/kronotskaya-v-shlyape.jpg' THEN
    RAISE WARNING '[1241] главный кадр Кроноцкого заповедника не лёг: у места другой показываемый снимок (%) или места нет', v_hero;
  END IF;
  IF v_gallery < 7 THEN
    RAISE WARNING '[1241] галерея Кроноцкого заповедника: % снимков из 7 — позиции заняты другими?', v_gallery;
  END IF;
END $$;

COMMIT;
