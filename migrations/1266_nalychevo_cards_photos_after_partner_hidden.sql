-- 1266: Снимки карточкам Налычевских источников, Налычевской долины и
-- Авачинского перевала — вместо спрятанных кадров партнёра
-- Created: 2026-10-15
--
-- ── Почему ────────────────────────────────────────────────────────────────
--
-- 1263 спрятала кадры «Местечка Камчатка» с карточек мест до согласия
-- партнёра (владелец 15.10: «пока нет получим согласе востановим»). У трёх
-- карточек Налычева других снимков не было вовсе: главным кадром у них стоял
-- кадр партнёра (1248), галереи не было — карточки остались с заставкой.
-- Главный кадр не заменяется: его строка — спрятанный кадр партнёра, она
-- ждёт согласия и сборщиком не перезаписывается. Снимки ложатся в галерею, и
-- карточка берёт первый из них главным (lib/places/place-detail.ts).
--
-- ── Чьи снимки ────────────────────────────────────────────────────────────
--
-- Владелец 14.10: «Только используй наши фотографии или фото партнеров по
-- возможности». Решено по его карт-бланшу 15.10 («ты уже лучше меня всё
-- знаешь»):
--   Авачинский перевал — снимок владельца: экструзия Верблюд (958; в
--     галерее парка он уже подписан «на Авачинском перевале», 1248);
--   источники и долина — своих снимков нет, партнёрские спрятаны, и
--     «по возможности» здесь кончается: снимки Wikimedia Commons, залитые
--     ещё 14.10 (media-to-s3, прогон 7) и тогда на карточки не поставленные.
--     Лицензии свободные, автор назван у каждого кадра — подпись выводит его
--     и ссылку на страницу файла.
--
-- Какой файл хранилища — какой файл Commons (размеры сверены: пережатие до
-- 1600 px по длинной стороне сохраняет пропорции оригинала):
--   termalnye-istochniki.jpg   ← «Налычевские термальные источники.jpg»,
--                                Rost.galis, CC BY-SA 4.0, 3859×2830;
--   termalnye-istochniki-2.jpg ← «Налычевские термальные источники 1.jpg»,
--                                Rost.galis, CC BY-SA 4.0, 4000×3000;
--   tretya-luzha-zimoj.jpg     ← «Третья "лужа".JPG» («Купальня на
--                                Центральном кордоне»), Jeskela,
--                                CC BY-SA 4.0, 1632×1224 — снимок зимний;
--   tretya-luzha-2009.jpg      ← «Nalychevo.jpg» («лужа №3, кордон
--                                Центральный», 2009), Gistereziz,
--                                общественное достояние, 2000×1500.
-- Авторы и лицензии — extmetadata Commons (пробы 853 и 859). Купальня с
-- конической крышей — «Третья лужа» на кордоне «Центральный» (1248).
--
-- Когда партнёр согласится и его кадры вернутся (хвост 1263), эти снимки
-- останутся в галерее следом за его кадрами — убирать их не нужно.
--
-- IDEMPOTENT: снимок с тем же ключом у места второй раз не ложится.

BEGIN;

WITH shots(place_id, ord, width, height, caption, author, license, license_url, source_url, s3_key) AS (
  VALUES
    ('c7c9f572-5e78-4d4f-a9ee-d0182eb313d6', 1, 1600, 1173,
     'Купальня «Третья лужа» и павильон на кордоне «Центральный»',
     'Rost.galis', 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%9D%D0%B0%D0%BB%D1%8B%D1%87%D0%B5%D0%B2%D1%81%D0%BA%D0%B8%D0%B5_%D1%82%D0%B5%D1%80%D0%BC%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D0%B5_%D0%B8%D1%81%D1%82%D0%BE%D1%87%D0%BD%D0%B8%D0%BA%D0%B8.jpg',
     'photos/nalychevo/termalnye-istochniki.jpg'),
    ('c7c9f572-5e78-4d4f-a9ee-d0182eb313d6', 2, 1600, 1200,
     'Купальня «Третья лужа» зимой',
     'Jeskela', 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%A2%D1%80%D0%B5%D1%82%D1%8C%D1%8F_%22%D0%BB%D1%83%D0%B6%D0%B0%22.JPG',
     'photos/nalychevo/tretya-luzha-zimoj.jpg'),
    ('4732f58e-63e5-4ec1-902e-f0f531391193', 1, 1600, 1200,
     'Термальный ручей у кордона «Центральный», за долиной — горы',
     'Rost.galis', 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%9D%D0%B0%D0%BB%D1%8B%D1%87%D0%B5%D0%B2%D1%81%D0%BA%D0%B8%D0%B5_%D1%82%D0%B5%D1%80%D0%BC%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D0%B5_%D0%B8%D1%81%D1%82%D0%BE%D1%87%D0%BD%D0%B8%D0%BA%D0%B8_1.jpg',
     'photos/nalychevo/termalnye-istochniki-2.jpg'),
    ('4732f58e-63e5-4ec1-902e-f0f531391193', 2, 1600, 1200,
     'Купальня «Третья лужа» на кордоне «Центральный» летом',
     'Gistereziz', 'Общественное достояние', NULL,
     'https://commons.wikimedia.org/wiki/File:Nalychevo.jpg',
     'photos/nalychevo/tretya-luzha-2009.jpg'),
    ('3dd2ceaf-1351-4625-9171-711eb8b1a455', 1, 1280, 720,
     'Экструзия Верблюд на Авачинском перевале',
     'владелец платформы', NULL, NULL, NULL,
     'migrations/photos/8553f67769b6977a0c140e7803860c1fdbc9e0008693a606577928298055eaa7.jpg')
)
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height,
                                  caption, author, license, license_url, source_url, s3_key)
SELECT p.ark_id,
       COALESCE((SELECT max(g.position) FROM place_gallery_photos g WHERE g.ark_id = p.ark_id), 0) + s.ord,
       NULL::bytea, 'image/jpeg', s.width, s.height,
       s.caption, s.author, s.license::text, s.license_url::text, s.source_url::text, s.s3_key
  FROM shots s
  JOIN places p ON p.id::text = s.place_id::text
 WHERE p.ark_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM place_gallery_photos g
                    WHERE g.ark_id = p.ark_id AND g.s3_key = s.s3_key)
ON CONFLICT (ark_id, position) DO NOTHING;

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_place text;
  v_shown int;
BEGIN
  FOREACH v_place IN ARRAY ARRAY['c7c9f572-5e78-4d4f-a9ee-d0182eb313d6',
                                 '4732f58e-63e5-4ec1-902e-f0f531391193',
                                 '3dd2ceaf-1351-4625-9171-711eb8b1a455'] LOOP
    SELECT count(*) INTO v_shown
      FROM places p
      JOIN place_gallery_photos g ON g.ark_id = p.ark_id AND g.hidden_reason IS NULL
     WHERE p.id::text = v_place::text;
    IF v_shown = 0 THEN
      RAISE WARNING '[1266] у места % по-прежнему нет показываемого снимка — места нет в базе или у него нет ark_id?', v_place;
    END IF;
  END LOOP;
END $$;

COMMIT;

-- Откат (снимки — не данные места, убрать их ничего не ломает):
-- DELETE FROM place_gallery_photos g USING places p
--  WHERE g.ark_id = p.ark_id
--    AND p.id::text IN ('c7c9f572-5e78-4d4f-a9ee-d0182eb313d6', '4732f58e-63e5-4ec1-902e-f0f531391193',
--                       '3dd2ceaf-1351-4625-9171-711eb8b1a455')
--    AND g.s3_key IN ('photos/nalychevo/termalnye-istochniki.jpg', 'photos/nalychevo/tretya-luzha-zimoj.jpg',
--                     'photos/nalychevo/termalnye-istochniki-2.jpg', 'photos/nalychevo/tretya-luzha-2009.jpg',
--                     'migrations/photos/8553f67769b6977a0c140e7803860c1fdbc9e0008693a606577928298055eaa7.jpg');
