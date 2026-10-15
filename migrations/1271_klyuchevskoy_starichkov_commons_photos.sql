-- 1271: Снимки карточкам «Парк «Ключевской»» и «Остров Старичков» — вместо
-- спрятанных кадров партнёров
-- Created: 2026-10-15
--
-- ── Почему ────────────────────────────────────────────────────────────────
--
-- 1263 и 1265 спрятали с карточек мест кадры «Местечка Камчатка» и «Края
-- Вулканов» до согласия партнёров. У двух карточек других снимков не было
-- вовсе — проба 940: у парка «Ключевской» photoCount 0, у острова Старичков
-- тоже. Главный кадр не заменяется: его строка — спрятанный кадр партнёра,
-- она ждёт согласия и сборщиком не перезаписывается. Снимки ложатся в
-- галерею, и карточка берёт первый из них главным (lib/places/place-detail.ts),
-- с полной подписью: автор, лицензия, страница файла (photoRights, 15.10).
--
-- ── Чьи снимки ────────────────────────────────────────────────────────────
--
-- Владелец 14.10: «Только используй наши фотографии или фото партнеров по
-- возможности». Своих снимков Ключевской группы и Старичкова у платформы
-- нет, партнёрские спрятаны — «по возможности» здесь кончается, как в 1266:
-- Wikimedia Commons, свободная лицензия, автор назван у каждого кадра. Решено
-- по карт-бланшу владельца 15.10.
--
-- Отбор — глазами, по закачке operator-photos (прогон 8); авторы и лицензии —
-- extmetadata Commons (проба 941). Пережаты до 1600 px по длинной стороне,
-- метаданные сняты, залиты media-to-s3 (прогон 15):
--   ostrov-s-morya.jpg               ← «Остров Старичков - Фото 1.jpg»,
--                                      Кулик Мария Владимировна, CC BY-SA 4.0;
--   ptichij-bazar-na-sklone.jpg      ← «Птичий базар на острове Старичков.jpg»,
--                                      Aysa t, CC BY-SA 4.0;
--   kekury-karaulnyj-i-chasovoj.jpg  ← «Вид на остров Старичков, кекур
--                                      Караульный и кекур Часовой.jpg»,
--                                      DoctisDM, CC BY-SA 4.0 — какой из
--                                      кекуров какой, автор не подписал, и
--                                      подпись этого не утверждает;
--   klyuchevskaya-na-voshode.jpg     ← «Ključevskaja za východu slunce.jpg»,
--                                      Tamten, общественное достояние;
--   klyuchevskaya-izverzhenie-1993.jpg ← «Klyuchevskaya Sopka eruption -
--                                      Kamchatka, Russian Federation - Summer
--                                      1993 03.jpg», Giorgio Galeotti,
--                                      CC BY-SA 4.0;
--   klyuchevskaya-zimoj.jpg          ← «Вулкан ключевская сопка.jpg»,
--                                      Zhuravell, CC BY-SA 3.0 — время года
--                                      автор не назвал, подпись говорит, что
--                                      видно: сопка в снегу.
-- Не взят кадр Galeotti с лавовым полем и группой на лугу: какой вулкан
-- вдали, по кадру не определить.
--
-- Когда партнёры согласятся и их кадры вернутся (хвосты 1263 и 1265), эти
-- снимки останутся в галерее следом — убирать их не нужно.
--
-- IDEMPOTENT: снимок с тем же ключом у места второй раз не ложится.

BEGIN;

WITH shots(place_id, ord, width, height, caption, author, license, license_url, source_url, s3_key) AS (
  VALUES
    ('4dd86a74-d010-4ff4-81ad-23af3ba966a5', 1, 1600, 1200,
     'Остров Старичков с моря',
     'Кулик Мария Владимировна', 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%9E%D1%81%D1%82%D1%80%D0%BE%D0%B2_%D0%A1%D1%82%D0%B0%D1%80%D0%B8%D1%87%D0%BA%D0%BE%D0%B2_-_%D0%A4%D0%BE%D1%82%D0%BE_1.jpg',
     'photos/starichkov/ostrov-s-morya.jpg'),
    ('4dd86a74-d010-4ff4-81ad-23af3ba966a5', 2, 1600, 1067,
     'Птичий базар на склоне острова',
     'Aysa t', 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%9F%D1%82%D0%B8%D1%87%D0%B8%D0%B9_%D0%B1%D0%B0%D0%B7%D0%B0%D1%80_%D0%BD%D0%B0_%D0%BE%D1%81%D1%82%D1%80%D0%BE%D0%B2%D0%B5_%D0%A1%D1%82%D0%B0%D1%80%D0%B8%D1%87%D0%BA%D0%BE%D0%B2.jpg',
     'photos/starichkov/ptichij-bazar-na-sklone.jpg'),
    ('4dd86a74-d010-4ff4-81ad-23af3ba966a5', 3, 1600, 720,
     'Кекуры Караульный и Часовой у острова Старичков',
     'DoctisDM', 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%92%D0%B8%D0%B4_%D0%BD%D0%B0_%D0%BE%D1%81%D1%82%D1%80%D0%BE%D0%B2_%D0%A1%D1%82%D0%B0%D1%80%D0%B8%D1%87%D0%BA%D0%BE%D0%B2,_%D0%BA%D0%B5%D0%BA%D1%83%D1%80_%D0%9A%D0%B0%D1%80%D0%B0%D1%83%D0%BB%D1%8C%D0%BD%D1%8B%D0%B9_%D0%B8_%D0%BA%D0%B5%D0%BA%D1%83%D1%80_%D0%A7%D0%B0%D1%81%D0%BE%D0%B2%D0%BE%D0%B9.jpg',
     'photos/starichkov/kekury-karaulnyj-i-chasovoj.jpg'),
    ('1c93607e-9a9e-4abc-a7dc-0a1b774c21d0', 1, 1600, 1200,
     'Ключевская сопка на восходе',
     'Tamten', 'Общественное достояние', NULL,
     'https://commons.wikimedia.org/wiki/File:Klju%C4%8Devskaja_za_v%C3%BDchodu_slunce.jpg',
     'photos/vulkany-kamchatki/klyuchevskaya-na-voshode.jpg'),
    ('1c93607e-9a9e-4abc-a7dc-0a1b774c21d0', 2, 1600, 1067,
     'Извержение Ключевской сопки летом 1993 года',
     'Giorgio Galeotti', 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:Klyuchevskaya_Sopka_eruption_-_Kamchatka,_Russian_Federation_-_Summer_1993_03.jpg',
     'photos/vulkany-kamchatki/klyuchevskaya-izverzhenie-1993.jpg'),
    ('1c93607e-9a9e-4abc-a7dc-0a1b774c21d0', 3, 1100, 721,
     'Ключевская сопка в снегу',
     'Zhuravell', 'CC BY-SA 3.0', 'https://creativecommons.org/licenses/by-sa/3.0',
     'https://commons.wikimedia.org/wiki/File:%D0%92%D1%83%D0%BB%D0%BA%D0%B0%D0%BD_%D0%BA%D0%BB%D1%8E%D1%87%D0%B5%D0%B2%D1%81%D0%BA%D0%B0%D1%8F_%D1%81%D0%BE%D0%BF%D0%BA%D0%B0.jpg',
     'photos/vulkany-kamchatki/klyuchevskaya-zimoj.jpg')
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
  FOREACH v_place IN ARRAY ARRAY['4dd86a74-d010-4ff4-81ad-23af3ba966a5',
                                 '1c93607e-9a9e-4abc-a7dc-0a1b774c21d0'] LOOP
    SELECT count(*) INTO v_shown
      FROM places p
      JOIN place_gallery_photos g ON g.ark_id = p.ark_id AND g.hidden_reason IS NULL
     WHERE p.id::text = v_place::text;
    IF v_shown = 0 THEN
      RAISE WARNING '[1271] у места % по-прежнему нет показываемого снимка — места нет в базе или у него нет ark_id?', v_place;
    END IF;
  END LOOP;
END $$;

COMMIT;

-- Откат (снимки — не данные места, убрать их ничего не ломает):
-- DELETE FROM place_gallery_photos g USING places p
--  WHERE g.ark_id = p.ark_id
--    AND p.id::text IN ('4dd86a74-d010-4ff4-81ad-23af3ba966a5', '1c93607e-9a9e-4abc-a7dc-0a1b774c21d0')
--    AND g.s3_key IN ('photos/starichkov/ostrov-s-morya.jpg', 'photos/starichkov/ptichij-bazar-na-sklone.jpg',
--                     'photos/starichkov/kekury-karaulnyj-i-chasovoj.jpg',
--                     'photos/vulkany-kamchatki/klyuchevskaya-na-voshode.jpg',
--                     'photos/vulkany-kamchatki/klyuchevskaya-izverzhenie-1993.jpg',
--                     'photos/vulkany-kamchatki/klyuchevskaya-zimoj.jpg');
