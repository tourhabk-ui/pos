-- 1246: Природный парк «Быстринский» — карточка парка по источникам, режим
--       мест внутри его контура, справочник парков с каналами разрешения.
-- Created: 2026-10-14
--
-- ── Почему ────────────────────────────────────────────────────────────────
--
-- Владелец 14.10, после Вачкажца и национального парка: «Природный парк
-- „Быстринский“ так же». Карточка места (c35c5024, проба 844 и MCP fetch
-- 14.10): тип «Лесной массив», район «Авачинский», описание — сочинение
-- без источника: «Алхалалалай» посреди стойбища (это праздник ительменов,
-- не эвенов Быстринского района), «парк на полтора миллиона гектаров»
-- (1 325 тысяч по постановлению 1996 года), «человек здесь не хозяин, а
-- гость, которого терпят». Режима, «как добраться», сути, источника нет;
-- профиль безопасности — шаблон 070. Отзыв Кузьмича о парке советует
-- ледоруб. Справочник парков: описание в одну строку, каналов разрешения нет.
--
-- «Быстринский» остаётся природным парком регионального значения: в
-- сообщении о национальном парке 14.10.2026 (kamchatkamedia.ru/news/2650854/)
-- объединены только «Ключевской» и «Южно-Камчатский» (миграция 1245).
--
-- ── Источники ─────────────────────────────────────────────────────────────
--
--   справка «Кластер „Быстринский“» краеведческого сайта kamchatsky-krai.ru
--     по справочнику Минприроды края «Особо охраняемые природные территории
--     Камчатского края» (2013, проба 845): постановления № 192 от 18.08.1995
--     и № 186 от 05.07.1996, площадь, ЮНЕСКО 6.12.1996, сёла, кордоны,
--     стоянки, звери и птицы, режим охоты и рыбалки;
--   Википедия «Быстринский природный парк» (проба 844): протяжённость,
--     климат, пять групп термальных источников, заказник «Ичинский»;
--   Википедия «Вулканы Камчатки (природный парк)» (проба 838): сеть 2009 года;
--   страница кластера на сайте парка (проба 845): эвены, коряки и ительмены
--     в сёлах, 14 маршрутов;
--   страница парка «Получение разрешения на посещение парка» (проба 543,
--     19.09; она же lib/safety/park-permit.ts): способы, адреса, часы, почта.
--
-- ── Какие места — по контуру, не по имени ─────────────────────────────────
--
-- Контур — отношение OpenStreetMap 21624152 «Природный парк „Быстринский“»
-- (Nominatim lookup, проба 846): 1 362 тысячи гектаров против 1 325 тысяч по
-- источнику — контур полный. Места — экспорт слоя мест по восьми клеткам
-- 55–56° с. ш., 156–159° в. д. (пробы 847, 848), проверка «точка в контуре»:
-- внутри 24 места. Режим не получают двое: «Эссовские горячие источники» и
-- «Шаманская поляна у Эссо» стоят в самом селе, а нужно ли разрешение парка
-- на улице районного центра, источники не говорят. Сама карточка парка —
-- отдельным оператором. Остальной 21 месту — режим «Природный парк»,
-- разрешение, ссылка на страницу парка о разрешениях и две строки правил из
-- источников вместо шаблонных абзацев 169/170. Меняется режим, только пока
-- он прежний: природный парк, ЮНЕСКО, «нет» или пусто.
--
-- Отзыв Кузьмича — пустая строка, а не NULL: агент kuzmich-place-enricher
-- берёт только NULL и написал бы новый пересказ (1159, 1243, 1244).
--
-- Профиль безопасности парка: из шаблона в `manual` целиком — медведи
-- (справочник: «из промысловых пушных зверей… медведь»), шаблонные поля
-- обнуляются явно. Профили мест внутри парка не трогаются: у вулканов и
-- источников свои опасности, и переносить на них опасности парка — то же
-- сочинение, только наоборот.
--
-- ── Фото ─────────────────────────────────────────────────────────────────
--
-- Wikimedia Commons, только со свободной лицензией и названным автором
-- (extmetadata, проба 845); залиты и прочитаны обратно до этой миграции
-- (media-to-s3, прогон 6: «Готово: 44 из 44»). Главный кадр — Ичинская
-- сопка: вулкан парка по обоим источникам. Галерея встаёт ПОСЛЕ снимков,
-- которые у места уже есть: позиция — следом за последней, снимок с тем же
-- ключом второй раз не ложится. «Дордон Дальний» залит, но не ставится:
-- что за место на снимке, по его подписи не установить.
--
-- ПОСЛЕ ВЫКАТА: полевая карта читает статичные пакеты мест (тип места и
-- опасности из профиля) — перезалить map-places-build (upload:true).
--
-- IDEMPOTENT: каждое изменение сужено до прежнего состояния.

BEGIN;

-- ═══ Карточка парка ══════════════════════════════════════════════════════

UPDATE places
   SET location_type = 'park', updated_at = NOW()
 WHERE id::text = 'c35c5024-238f-44ec-85f6-c31127fdfffb'
   AND location_type = 'forest';

-- Эссо — центр Камчатки; «Авачинский» стоял от импорта.
UPDATE places
   SET zone = 'central', updated_at = NOW()
 WHERE id::text = 'c35c5024-238f-44ec-85f6-c31127fdfffb'
   AND zone = 'avachinsky';

UPDATE places
   SET essence = 'Самый большой природный парк Камчатского края: долина реки Быстрой между Срединным '
              || 'и Козыревским хребтами, Ичинская сопка, термальные источники, эвенские сёла Эссо и '
              || 'Анавгай; часть объекта Всемирного наследия ЮНЕСКО «Вулканы Камчатки» с 1996 года.',
       description =
          'Природный парк «Быстринский» — самый большой природный парк Камчатского края, 1 325 тысяч '
       || 'гектаров в центре полуострова. Он лежит в долине реки Быстрой между Срединным и Козыревским '
       || 'хребтами и включает бассейн реки Анавгай, верховья Тигиля на севере и правые притоки Ичи на '
       || 'юге. Парк создан постановлением главы администрации Камчатской области от 18 августа 1995 '
       || 'года № 192; в 1996 году его южную границу изменили, чтобы вывести за пределы парка Агинское '
       || 'золоторудное и медно-никелевое Шануч месторождения. 6 декабря 1996 года парк включён в объект '
       || 'Всемирного природного наследия ЮНЕСКО «Вулканы Камчатки», с 2009 года он — кластер природного '
       || 'парка «Вулканы Камчатки».'
       || E'\n'
       || 'Здесь стоит Ичинская сопка — самый высокий действующий вулкан Срединного хребта. В парке '
       || 'собраны все типы зональной растительности Центральной Камчатки: альпийская тундра, луга, '
       || 'лиственные и хвойные леса, лесотундра. Крупных групп термальных источников пять — '
       || 'Апапельско-Оксинская, Анавгайская, Быстринская, Эссовская и Козыревская; Апапельско-Оксинские '
       || 'источники кипящие, у выхода на поверхность вода около 100 °С. Лето здесь короткое и жаркое, '
       || 'зима безветренная и морозная: средняя температура января — минус 19 °С, июля — 12–14 °С.'
       || E'\n'
       || 'Внутри парка лежат сёла Эссо — районный центр Быстринского района — и Анавгай. Это место '
       || 'исторически компактного проживания эвенов; в сёлах живут и ведут традиционный образ жизни '
       || 'эвены, коряки и ительмены, а оленьи пастбища есть по всей территории парка. На берегу реки '
       || 'Анавгай работает этнографический комплекс «Мэнедек», рядом с селом Анавгай найдена неолитическая '
       || 'стоянка человека. С 1990 года из Эссо ежегодно стартует гонка на собачьих упряжках «Берингия».'
       || E'\n'
       || 'В парке живут бурый медведь, лось, снежный баран, дикий северный олень, соболь, росомаха, выдра; '
       || 'птиц — 137 видов, среди них сапсан и беркут из Красной книги. Внутри парка — региональный '
       || 'заказник «Ичинский», два кордона — Димшиканский и Ичинский — и больше десяти обустроенных '
       || 'стоянок; сайт парка насчитывает 14 туристических маршрутов. Посещение — по разрешению КГБУ '
       || '«Природный парк „Вулканы Камчатки“».',
       updated_at = NOW()
 WHERE id::text = 'c35c5024-238f-44ec-85f6-c31127fdfffb'
   AND description LIKE 'Горячие источники Эссо парят у подножия Ичинского%';

-- Отзыв снимается отдельно от описания: описание мог уже поправить
-- человек, а совет про ледоруб от этого правдой не станет.
UPDATE places
   SET kuzmich_review = '', updated_at = NOW()
 WHERE id::text = 'c35c5024-238f-44ec-85f6-c31127fdfffb'
   AND kuzmich_review LIKE '%без ледоруба не обойтись%';

-- «Как добраться» допишет само расстояние от города, маршруты каталога и
-- строку о режиме (lib/places/access-text.ts) — здесь только записанное.
UPDATE places
   SET access_info = 'Эссо — районный центр Быстринского района внутри парка; от Петропавловска-Камчатского '
                  || 'до него 530 км. Разрешение на посещение выдаёт КГБУ «Природный парк „Вулканы Камчатки“» — '
                  || 'в приложении «Зелёная кнопка», на портале Госуслуги41, по заявке на visit@park-vulcany.ru '
                  || 'или в туристском информационном центре парка в Эссо (улица Ленина, 8).',
       updated_at = NOW()
 WHERE id::text = 'c35c5024-238f-44ec-85f6-c31127fdfffb'
   AND access_info IS NULL;

-- Подвал карточки молчал об источнике (sourceName null, проба 844).
UPDATE places
   SET source_name = 'kamchatsky-krai.ru; Википедия; сайт парка «Вулканы Камчатки»',
       source_url = 'https://www.kamchatsky-krai.ru/geography/oopt/parks/bystrinskiy.htm',
       updated_at = NOW()
 WHERE id::text = 'c35c5024-238f-44ec-85f6-c31127fdfffb'
   AND source_name IS NULL AND source_url IS NULL;

-- ═══ Режим: парк и места внутри контура ══════════════════════════════════

WITH members(id, name) AS (
  VALUES
    ('c35c5024-238f-44ec-85f6-c31127fdfffb', 'Природный парк «Быстринский»'),
    ('f3a1c9d2-7b45-4e18-9c62-a80417d5b906', 'Апапельские горячие источники'),
    ('67863466-6c62-4d28-8fd7-6e0d0c28a082', 'Белые скалы'),
    ('a49536e5-dd2e-454e-9c4b-645768a78669', 'Быстринские термальные источники (47-й км)'),
    ('5fb778bb-1e7c-4cf0-ae32-6162850ebdaa', 'Вид на Эссо'),
    ('88e23147-13e4-4bed-bae6-6dbcaf277cf9', 'Вид на озеро Икар'),
    ('6f9e8d56-f772-465a-bdf0-7524e5872a6e', 'Гора Дыгерен-Оленгенде'),
    ('af6af4ea-357e-4a98-9562-410ac41e650f', 'Димшиканский кордон'),
    ('400e2a7e-2372-4abe-8f8c-9f66dbde94f9', 'Зеленые скалы'),
    ('625fac2b-1790-441c-b57e-1a70ddf74dd8', 'Ичинский Вулкан'),
    ('169acf0f-06cf-40eb-bfd0-8e80d2001d6c', 'Озеро Галямаки'),
    ('f616768c-fd81-4745-90d7-1f9fba8fe2b7', 'Озеро Икар'),
    ('3578daee-897f-4a11-940f-ca6fe06f80d8', 'Озеро Илмаган'),
    ('dfd7a894-5608-4de1-9719-8322c41a1135', 'Озеро Луны'),
    ('1f992bd6-0510-447b-a1ed-c48c683f9ace', 'Оксинские источники'),
    ('f05cc7de-6906-4255-8c24-64469fc1ee6d', 'Северный Черпук'),
    ('b61c84d3-4e59-45b9-853a-812e5f6b6c8b', 'Скала Череп'),
    ('c55c9ce5-5d90-44b8-b933-ed8d1e560fb3', 'Скала Черный замок'),
    ('8bdb74e9-42a3-4aa9-94db-7b51483dd108', 'Сопка Кризалис'),
    ('1295a603-852b-4482-9c74-0f97aba3f392', 'Чинейнейн'),
    ('790b3f98-b561-4818-80eb-8da0930d157d', 'Эко-тропа Тупикин ключ'),
    ('3134db1a-9e33-46e5-b706-32e043ff71ba', 'Южный Черпук')
)
UPDATE places p
   SET eco_zone = 'natural_park',
       eco_permit_required = TRUE,
       eco_permit_url = 'https://www.vulcanikamchatki.ru/v_pomow_gostyu/usloviya_poseweniya/',
       eco_rules = 'Посещение — по разрешению КГБУ «Природный парк „Вулканы Камчатки“»: в приложении «Зелёная кнопка», на портале Госуслуги41, заявкой на visit@park-vulcany.ru, в туристском информационном центре парка в Эссо (улица Ленина, 8) или в офисе в Елизово (улица Завойко, 33)'
                || E'\n'
                || 'Охота — только по разрешениям (лицензиям) и не в заказнике «Ичинский», промысловая рыбалка — по лицензиям на рыбохозяйственных участках',
       updated_at = NOW()
  FROM members m
 WHERE p.id::text = m.id::text
   AND (p.eco_zone IS NULL OR p.eco_zone IN ('none', 'natural_park', 'UNESCO'));

-- ═══ Профиль безопасности парка ══════════════════════════════════════════

UPDATE location_safety_profile lsp
   SET hazard_types = ARRAY['bears']::text[],
       capacity_per_day = NULL,
       capacity_per_hour = NULL,
       optimal_group_size = NULL,
       difficulty_level = NULL,
       terrain_type = NULL,
       road_type = NULL,
       road_accessibility = NULL,
       profile_source = 'manual',
       profile_source_at = NOW(),
       updated_at = NOW()
  FROM places p
 WHERE p.id::text = 'c35c5024-238f-44ec-85f6-c31127fdfffb'
   AND lsp.agent_route_id = p.ark_id
   AND lsp.profile_source = 'type_template';

-- ═══ Главный кадр и галерея ══════════════════════════════════════════════

INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height,
                             author, license, license_url, source_url, s3_key)
SELECT p.ark_id, NULL::bytea, 'image/jpeg',
       'Wikimedia Commons: «Вулкан Ичинская сопка» (миграция 1246)',
       'wikimedia', 1600, 1067,
       'NadezhdaKhaustova', 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0',
       'https://commons.wikimedia.org/wiki/File:%D0%92%D1%83%D0%BB%D0%BA%D0%B0%D0%BD_%D0%98%D1%87%D0%B8%D0%BD%D1%81%D0%BA%D0%B0%D1%8F_%D1%81%D0%BE%D0%BF%D0%BA%D0%B0.jpg',
       'photos/bystrinsky/ichinskaya-sopka.jpg'
  FROM places p
 WHERE p.id::text = 'c35c5024-238f-44ec-85f6-c31127fdfffb'
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

-- Подписи — названия файлов у авторов; английское переведено.
WITH shots(ord, width, height, caption, author, license, license_url, source_url, s3_key) AS (
  VALUES
    (1, 1600, 1067, 'Озеро Абунат', 'NadezhdaKhaustova', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%9E%D0%B7%D0%B5%D1%80%D0%BE_%D0%90%D0%B1%D1%83%D0%BD%D0%B0%D1%82.jpg',
     'photos/bystrinsky/ozero-abunat.jpg'),
    (2, 1600, 1067, 'Долина в Быстринском парке', 'NadezhdaKhaustova', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%94%D0%BE%D0%BB%D0%B8%D0%BD%D0%B0_%D0%B2_%D0%91%D1%8B%D1%81%D1%82%D1%80%D0%B8%D0%BD%D1%81%D0%BA%D0%BE%D0%BC_%D0%BF%D0%B0%D1%80%D0%BA%D0%B5.jpg',
     'photos/bystrinsky/dolina.jpg'),
    (3, 1600, 1067, 'Гора Скалистая в Быстринском парке', 'NadezhdaKhaustova', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%93%D0%BE%D1%80%D0%B0_%D0%A1%D0%BA%D0%B0%D0%BB%D0%B8%D1%81%D1%82%D0%B0%D1%8F_%D0%B2_%D0%91%D1%8B%D1%81%D1%82%D1%80%D0%B8%D0%BD%D1%81%D0%BA%D0%BE%D0%BC_%D0%BF%D0%B0%D1%80%D0%BA%D0%B5.jpg',
     'photos/bystrinsky/gora-skalistaya.jpg'),
    (4, 1600, 1067, 'Олени в Быстринском парке', 'NadezhdaKhaustova', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%9E%D0%BB%D0%B5%D0%BD%D0%B8_%D0%B2_%D0%91%D1%8B%D1%81%D1%82%D1%80%D0%B8%D0%BD%D1%81%D0%BA%D0%BE%D0%BC_%D0%BF%D0%B0%D1%80%D0%BA%D0%B5.jpg',
     'photos/bystrinsky/oleni.jpg'),
    (5, 1600, 1067, 'Ичинский вулкан на закате', 'NadezhdaKhaustova', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%98%D1%87%D0%B8%D0%BD%D1%81%D0%BA%D0%B8%D0%B9_%D0%B2%D1%83%D0%BB%D0%BA%D0%B0%D0%BD_%D0%BD%D0%B0_%D0%B7%D0%B0%D0%BA%D0%B0%D1%82%D0%B5.jpg',
     'photos/bystrinsky/ichinskij-zakat.jpg'),
    (6, 1600, 1200, 'Деревянные дома в Эссо', 'Johannes Rohr', 'CC BY-SA 3.0',
     'https://creativecommons.org/licenses/by-sa/3.0',
     'https://commons.wikimedia.org/wiki/File:Wooden_houses_in_Esso,_Kamchatka,_Russia.jpg',
     'photos/bystrinsky/esso-doma.jpg')
)
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height,
                                  caption, author, license, license_url, source_url, s3_key)
SELECT p.ark_id,
       COALESCE((SELECT max(g.position) FROM place_gallery_photos g WHERE g.ark_id = p.ark_id), 0) + s.ord,
       NULL::bytea, 'image/jpeg', s.width, s.height,
       s.caption, s.author, s.license, s.license_url, s.source_url, s.s3_key
  FROM shots s
  JOIN places p ON p.id::text = 'c35c5024-238f-44ec-85f6-c31127fdfffb'
 WHERE p.ark_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM place_gallery_photos g
                    WHERE g.ark_id = p.ark_id AND g.s3_key = s.s3_key)
ON CONFLICT (ark_id, position) DO NOTHING;

-- ═══ Справочник парков ═══════════════════════════════════════════════════

-- Ссылка «Получить» вела на новость 2022 года (781); страница парка о
-- разрешениях — та, по которой сверены способы (проба 543).
UPDATE parks
   SET description = 'Самый большой природный парк Камчатского края — 1 325 тысяч гектаров в центре '
                  || 'полуострова: долина реки Быстрой между Срединным и Козыревским хребтами, Ичинская '
                  || 'сопка — самый высокий действующий вулкан Срединного хребта, термальные источники, '
                  || 'эвенские сёла Эссо и Анавгай. С 1996 года — часть объекта Всемирного наследия ЮНЕСКО '
                  || '«Вулканы Камчатки», с 2009 года — кластер природного парка «Вулканы Камчатки». '
                  || 'Посещение — по разрешению КГБУ «Природный парк „Вулканы Камчатки“»; его выдаёт и '
                  || 'туристский информационный центр парка в Эссо.',
       permit_url = 'https://www.vulcanikamchatki.ru/v_pomow_gostyu/usloviya_poseweniya/',
       permit_office_address = 'село Эссо, улица Ленина, 8 — туристский информационный центр парка, '
                            || 'тел. 8 (41542) 2-16-88, 2-14-61',
       permit_office_hours = 'ежедневно 9:00–18:00, перерыв 13:00–14:00',
       permit_email = 'visit@park-vulcany.ru',
       permit_gosuslugi_url = 'https://gosuslugi41.ru/pgu/volcano_info.htm',
       updated_at = NOW()
 WHERE slug = 'bystrinskiy'
   AND description = 'Самый большой природный парк Камчатки. Центральная Камчатка, долина реки Быстрой, медведи, нетронутая тайга.';

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_place record;
  v_profile text;
  v_hero text;
  v_gallery int;
  v_regime int;
  v_park record;
BEGIN
  SELECT name, location_type, zone, eco_zone, description, kuzmich_review,
         essence IS NOT NULL AS has_essence, access_info IS NOT NULL AS has_access
    INTO v_place
    FROM places WHERE id::text = 'c35c5024-238f-44ec-85f6-c31127fdfffb';
  SELECT lsp.profile_source INTO v_profile
    FROM location_safety_profile lsp JOIN places p ON lsp.agent_route_id = p.ark_id
   WHERE p.id::text = 'c35c5024-238f-44ec-85f6-c31127fdfffb';
  SELECT i.s3_key INTO v_hero
    FROM ai_route_images i JOIN places p ON i.route_id = p.ark_id
   WHERE p.id::text = 'c35c5024-238f-44ec-85f6-c31127fdfffb';
  SELECT count(*) INTO v_gallery
    FROM place_gallery_photos g JOIN places p ON g.ark_id = p.ark_id
   WHERE p.id::text = 'c35c5024-238f-44ec-85f6-c31127fdfffb' AND g.s3_key LIKE 'photos/bystrinsky/%';
  SELECT count(*) INTO v_regime FROM places
   WHERE eco_zone = 'natural_park'
     AND eco_rules LIKE 'Посещение — по разрешению КГБУ «Природный парк „Вулканы Камчатки“»: в приложении%';
  SELECT description, permit_email INTO v_park FROM parks WHERE slug = 'bystrinskiy';

  IF v_place.name IS NULL THEN
    RAISE WARNING '[1246] парка (c35c5024) нет в places';
  ELSE
    IF v_place.location_type IS DISTINCT FROM 'park' OR v_place.zone IS DISTINCT FROM 'central' THEN
      RAISE WARNING '[1246] тип % и район % парка — не «park» и «central»: их уже кто-то поменял?',
        v_place.location_type, v_place.zone;
    END IF;
    IF v_place.description LIKE 'Горячие источники Эссо парят%' OR NOT v_place.has_essence OR NOT v_place.has_access THEN
      RAISE WARNING '[1246] описание-сочинение осталось или суть (%) и «как добраться» (%) пусты',
        v_place.has_essence, v_place.has_access;
    END IF;
    IF v_place.kuzmich_review LIKE '%без ледоруба%' THEN
      RAISE WARNING '[1246] отзыв Кузьмича о ледорубе остался';
    END IF;
    IF v_place.eco_zone IS DISTINCT FROM 'natural_park' THEN
      RAISE WARNING '[1246] режим парка не записан: eco_zone %', v_place.eco_zone;
    END IF;
  END IF;
  IF v_profile IS DISTINCT FROM 'manual' THEN
    RAISE WARNING '[1246] профиль безопасности парка не переведён: profile_source % (ждали шаблон)', v_profile;
  END IF;
  IF v_hero IS DISTINCT FROM 'photos/bystrinsky/ichinskaya-sopka.jpg' THEN
    RAISE WARNING '[1246] главный кадр — % (у места был снимок, поставленный человеком?)', v_hero;
  END IF;
  IF v_gallery < 6 THEN
    RAISE WARNING '[1246] галерея: снимков Commons % из 6', v_gallery;
  END IF;
  IF v_regime < 22 THEN
    RAISE WARNING '[1246] режим «Природный парк» с правилами лёг у % мест из 22 — остальные скрыты, слиты или их режим уже записан иначе', v_regime;
  END IF;
  IF v_park.permit_email IS DISTINCT FROM 'visit@park-vulcany.ru' THEN
    RAISE WARNING '[1246] справочник парков: запись bystrinskiy не обновлена — описание уже правили?';
  END IF;
END $$;

COMMIT;

-- Rollback (сочинение и шаблонные правила не возвращаем — источники их опровергают):
-- BEGIN;
-- UPDATE places SET location_type = 'forest', zone = 'avachinsky', essence = NULL, access_info = NULL,
--        source_name = NULL, source_url = NULL
--  WHERE id::text = 'c35c5024-238f-44ec-85f6-c31127fdfffb';
-- DELETE FROM place_gallery_photos g USING places p
--  WHERE g.ark_id = p.ark_id AND p.id::text = 'c35c5024-238f-44ec-85f6-c31127fdfffb'
--    AND g.s3_key LIKE 'photos/bystrinsky/%';
-- COMMIT;
