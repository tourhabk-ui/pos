-- 1243: Корякский заповедник и национальный парк «Командорские острова» —
--       тип, справка по источникам, разрешение, безопасность, координата, фото.
-- Created: 2026-10-14
--
-- ── Почему ────────────────────────────────────────────────────────────────
--
-- Владелец 14.10, после страницы Кроноцкого заповедника (1240, 1241):
-- «Перенеси в Заповедники и наверное тоже сделай также как с [Кроноцким] все
-- заповедники». Других государственных заповедников в крае два, оба заведены
-- миграцией 102 в legacy-таблицу и записаны `forest` — «Лесной массив».
--
-- ── Командорский — уже не заповедник ──────────────────────────────────────
--
-- Постановлением Правительства № 720 от 21 апреля 2022 года заповедник
-- «Командорский» преобразован в национальный парк «Командорские острова»
-- (government.ru/docs/45241, проба 828; Интерфакс 25.04.2022; Википедия).
-- Подписать его «Заповедником» значило бы написать неправду, а `park` у нас —
-- региональный природный парк с другим режимом. Поэтому тип `national_park`,
-- режим охраны `national_park` и имя «Командорские острова»; прежние имена —
-- в псевдонимах, чтобы поиск по «Командорскому заповеднику» находил парк.
--
-- ── Что было на проде (пробы 824, 839) ────────────────────────────────────
--
-- Оба описания — путевые заметки от первого лица, которых никто не писал:
--   Командорский: «Туман здесь не поднимается, а приползает с моря… Я стоял на
--   берегу Медного… Сивучи на скалах даже не шевельнулись, когда я приблизился
--   на сотню шагов… Грунтовка от Никольского кончается у воды…»;
--   Корякский: «Вертолёт садится прямо в тундру — другого пути сюда нет… На
--   галечных косах полуострова Говена лежат тысячи моржовых туш… Из воды
--   выныривает горбатый силуэт кита…».
-- Отзывы Кузьмича пересказывают их же («сивучи лежат в пяти метрах» — ещё и
-- приглашение подойти к зверю). Отзыв — пустая строка, а не NULL: агент
-- kuzmich-place-enricher берёт только NULL и написал бы новый пересказ (1159).
-- Фото, профиля безопасности, режима охраны, сезона и «как добраться» не было.
--
-- ── Откуда текст ─────────────────────────────────────────────────────────
--
-- Командорские острова: статьи Википедии «Командорские острова (национальный
-- парк)» и «Командорские острова» (пробы 825, 833); постановление № 720 и
-- сообщение Минприроды (Интерфакс); сайт парка komandorsky.ru — страницы
-- «Туристам» и «О переводе заповедника в национальный парк» по архиву
-- Wayback от 2026 года (пробы 835–837): сам домен с раннера не отвечает, а
-- архивная копия одной из его страниц — заглушка регистратора о продлении
-- домена. Поэтому ссылки на komandorsky.ru нет нигде, в том числе в
-- справочнике парков: прежняя кнопка «Получить» вела в никуда.
-- Корякский: kronoki.ru — заявка на посещение (та же форма, что у Кроноцкого:
-- заповедником с 2015 года управляет ФГБУ «Кроноцкий государственный
-- заповедник») и раздел «Корякский заповедник», страницы 339–344 (проба 832);
-- статья Википедии «Корякский заповедник» (проба 825).
-- Чего в источниках нет — нет и здесь: лучшего сезона, транспорта, нужна ли
-- регистрация в МЧС, вместимости и сложности (§4.0).
--
-- ── Координаты ───────────────────────────────────────────────────────────
--
-- Командорские: 54.9309363 / 166.9248504 лежала в море между островами Беринга
-- и Медный — обратное геокодирование не находит там даже района (проба 841),
-- а ближайшие места каталога были в 33–48 км. Новая точка — та, что
-- OpenStreetMap отдаёт для острова Беринга (отношение 4176597): 55.0215754 /
-- 166.2712426, проверено, что она внутри контура острова. Остров целиком
-- входит в национальный парк (страница «Туристам» сайта парка).
-- Корякский: заглушка 60.0 / 165.5 (миграция 102). CLAUDE.md (10.09) считал её
-- «внутри настоящих границ» — это неверно: по контуру отношения OSM 5576455
-- она не попадает ни в один из трёх участков (проба 841). Новая точка — та,
-- что OSM отдаёт для этого отношения: 59.8865406 / 166.2616559, внутри
-- участка «Мыс Говена», Олюторский район.
--
-- ── Адреса карточек не меняются ──────────────────────────────────────────
--
-- /places/komandorskij-gosudarstvennyj-prirodnyj-biosfernyj-zapovednik и
-- /places/koryakskij-prirodnyj-zapovednik (проба 842). Истории slug нет, и
-- новый адрес оставил бы старые ссылки без страницы.
--
-- ── Фото ─────────────────────────────────────────────────────────────────
--
-- Wikimedia Commons, только со свободной лицензией и названным автором
-- (extmetadata, проба 831); залиты и прочитаны обратно до этой миграции
-- (media-to-s3, прогон 4: «Готово: 32 из 32»). Подписи — названия файлов у
-- авторов, итальянское переведено. Главный кадр ложится, только если у места
-- нет показываемого снимка или это повтор этой же миграции; галерея — ON
-- CONFLICT DO NOTHING по позиции.
--
-- ПОСЛЕ ВЫКАТА: полевая карта читает статичные пакеты мест — нужен перезалив
-- map-places-build (upload:true): у обоих мест новые точки и типы.
--
-- IDEMPOTENT

BEGIN;

-- ═══ Корякский заповедник ════════════════════════════════════════════════

UPDATE places
   SET location_type = 'reserve', updated_at = NOW()
 WHERE id::text = 'b9c4e312-6d8f-4a5b-9c71-3e2f1d0b7a46'
   AND location_type = 'forest';

UPDATE places
   SET lat = 59.8865406, lng = 166.2616559,
       coord_source = 'external', coord_source_at = NOW(), updated_at = NOW()
 WHERE id::text = 'b9c4e312-6d8f-4a5b-9c71-3e2f1d0b7a46'
   AND lat = 60.0 AND lng = 165.5;

UPDATE places
   SET name = 'Корякский заповедник',
       essence = 'Заповедник на севере Камчатского края: гористый полуостров Говена с лежбищами '
              || 'сивучей и моржей и озёрный Парапольский дол — один из богатейших птичьих районов '
              || 'Северо-Востока Азии.',
       description =
          'Корякский государственный природный заповедник лежит на севере Камчатского края, в '
       || 'Олюторском и Пенжинском районах. Он создан в 1995 году, а с 2015-го им управляет ФГБУ '
       || '«Кроноцкий государственный заповедник». Заповедник состоит из трёх участков: «Мыс Говена» '
       || 'и «Бухта Лаврова» — на гористом полуострове Говена между заливами Корфа и Олюторским '
       || 'Берингова моря, «Парапольский дол» — далеко к северу, в заболоченной Парапольской '
       || 'низменности. Площадь — 327 156 гектаров, из них 83 тысячи — акватория Берингова моря.'
       || E'\n'
       || 'Полуостров Говена — часть Корякского нагорья: хребты, разрезанные глубокими долинами, '
       || 'ущелья с каньонами и водопадами, горные тундры и заросли кедрового стланика. Парапольский '
       || 'дол — низменность с широкими речными долинами: в бассейне реки Куюл около 10 000 озёр, '
       || 'самое крупное — Таловское, 43,8 км². Растительность заповедника — берингийская лесотундра.'
       || E'\n'
       || 'Бурые медведи встречаются здесь повсюду — от морского берега до альпийского пояса; на '
       || 'полуострове Говена держится снежный баран, на Парапольском доле — лось. На мысе Говена — '
       || 'одно из крупных, но непостоянных лежбищ сивучей, от 300 до 2,5 тысячи зверей, на '
       || 'побережье — временные лежбища тихоокеанского моржа, на прибрежных скалах — около 30 '
       || 'колоний морских птиц, больше 12 тысяч пар. Озёра Парапольского дола — один из богатейших '
       || 'птичьих районов Северо-Востока Азии: здесь держится до 100–120 тысяч уток, и этот участок '
       || 'охраняется Рамсарской конвенцией как водно-болотное угодье международного значения. В '
       || 'Таловском озере и реке Куюл живёт пенжинский омуль — кроме бассейнов Пенжины и Таловки, '
       || 'он не встречается нигде.'
       || E'\n'
       || 'Климат суровый и ветреный: безморозный период в глубине суши — 90–95 дней, на побережье — '
       || '130–145, безветренной погоды почти не бывает — около 2% времени. Посещение — только по '
       || 'разрешению: заявку подают так же, как в Кроноцкий заповедник, — форму скачивают на '
       || 'kronoki.ru и отправляют на tourism@kronoki.ru; сама заявка разрешения ещё не даёт. В селе '
       || 'Тиличики работает этно-экологический центр заповедника.',
       -- Разрешение «Как добраться» допишет само — из режима территории
       -- (lib/places/access-text.ts).
       access_info = 'Заявку на посещение скачивают на kronoki.ru/ru/visit/requests/ и отправляют на '
                  || 'tourism@kronoki.ru — Корякским заповедником управляет Кроноцкий. Заход судна или '
                  || 'посадка вертолёта, даже вынужденные, по погоде, оформляются отдельной заявкой на '
                  || 'ohrana@kronoki.ru.',
       eco_zone = 'federal_reserve',
       eco_permit_required = TRUE,
       eco_permit_url = 'https://kronoki.ru/ru/visit/requests/',
       eco_rules = 'Посещение — только по разрешению заповедника: заявку скачивают на kronoki.ru и отправляют на tourism@kronoki.ru, сама заявка разрешения ещё не даёт'
                || E'\n'
                || 'Заход судов и посадка вертолётов, даже вынужденные, оформляются отдельной заявкой на ohrana@kronoki.ru'
                || E'\n'
                || 'На территории и в акватории запрещена любая деятельность, противоречащая режиму заповедника',
       kuzmich_review = '',
       source_name = 'kronoki.ru; Википедия; OpenStreetMap (отношение 5576455)',
       source_url = 'https://kronoki.ru/ru/kamchatka/koryakskiy-zapovednik/',
       updated_at = NOW()
 WHERE id::text = 'b9c4e312-6d8f-4a5b-9c71-3e2f1d0b7a46'
   AND description LIKE '%тысячи моржовых туш%';

-- Другие имена: прежнее имя карточки; официальное — по Википедии; английское —
-- категория Commons из Викиданных (P373).
WITH wanted(alias, src) AS (
  VALUES
    ('Корякский природный заповедник',                 'прежнее имя карточки (миграция 102)'),
    ('Корякский государственный природный заповедник', 'Википедия'),
    ('Koryak Nature Reserve',                          'Викиданные Q4234716, P373')
)
INSERT INTO place_aliases (place_id, alias, source_name)
SELECT p.id::text, w.alias, w.src
  FROM wanted w
  JOIN places p ON p.id::text = 'b9c4e312-6d8f-4a5b-9c71-3e2f1d0b7a46' AND p.name = 'Корякский заповедник'
 WHERE p.merged_into_id IS NULL
ON CONFLICT (place_id, LOWER(TRIM(alias))) DO NOTHING;

-- Профиль: медведи «встречаются повсеместно» (kronoki.ru, «Фауна»). Остальное
-- не записано — умолчания 0645 перекрыты NULL явно, как в 1240.
-- registration_required — NOT NULL с умолчанием FALSE; карточка, MCP и
-- Кузьмич говорят о регистрации в МЧС только при TRUE, так что FALSE здесь
-- значит «не записано», а не «не нужна»: источники об этом молчат.
INSERT INTO location_safety_profile
  (agent_route_id, capacity_per_day, capacity_per_hour, optimal_group_size,
   difficulty_level, sat_communicator_required, road_type, road_accessibility,
   hazard_types, registration_required, profile_source, profile_source_at)
SELECT p.ark_id, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL,
       ARRAY['bears']::text[], FALSE, 'manual', NOW()
  FROM places p
 WHERE p.id::text = 'b9c4e312-6d8f-4a5b-9c71-3e2f1d0b7a46'
   AND p.ark_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM location_safety_profile l WHERE l.agent_route_id::text = p.ark_id::text);

-- Главный кадр и галерея.
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height,
                             author, license, license_url, source_url, s3_key)
SELECT p.ark_id, NULL::bytea, 'image/jpeg',
       'Wikimedia Commons: «Участок Корякского заповедника на полуострове Говена» (миграция 1243)',
       'wikimedia', 900, 579,
       'Игорь Шпиленок', 'CC BY-SA 3.0', 'https://creativecommons.org/licenses/by-sa/3.0',
       'https://commons.wikimedia.org/wiki/File:Korjaksky_nature_reserve.jpg',
       'photos/koryaksky/poluostrov-govena.jpg'
  FROM places p
 WHERE p.id::text = 'b9c4e312-6d8f-4a5b-9c71-3e2f1d0b7a46'
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

INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height,
                                  caption, author, license, license_url, source_url, s3_key)
SELECT p.ark_id, 1, NULL::bytea, 'image/jpeg', 582, 695,
       'Полуостров Говена из космоса', 'NASA', 'Общественное достояние', NULL,
       'https://commons.wikimedia.org/wiki/File:%D0%9F%D0%BE%D0%BB%D1%83%D0%BE%D1%81%D1%82%D1%80%D0%BE%D0%B2_%D0%93%D0%BE%D0%B2%D0%B5%D0%BD%D0%B0.jpg',
       'photos/koryaksky/poluostrov-govena-iz-kosmosa.jpg'
  FROM places p
 WHERE p.id::text = 'b9c4e312-6d8f-4a5b-9c71-3e2f1d0b7a46'
   AND p.ark_id IS NOT NULL
ON CONFLICT (ark_id, position) DO NOTHING;

-- ═══ Национальный парк «Командорские острова» ════════════════════════════

UPDATE places
   SET location_type = 'national_park', updated_at = NOW()
 WHERE id::text = 'a8f3d201-5c9e-4b7a-8d63-2f1e0c4b6a35'
   AND location_type = 'forest';

UPDATE places
   SET lat = 55.0215754, lng = 166.2712426,
       coord_source = 'external', coord_source_at = NOW(), updated_at = NOW()
 WHERE id::text = 'a8f3d201-5c9e-4b7a-8d63-2f1e0c4b6a35'
   AND abs(lat - 54.9309363) < 0.000001 AND abs(lng - 166.9248504) < 0.000001;

UPDATE places
   SET name = 'Командорские острова',
       essence = 'Самый большой национальный парк России: острова Беринга и Медный, лежбища морских '
              || 'котиков и сивучей, каланы, киты и могила Витуса Беринга.',
       description =
          'Национальный парк «Командорские острова» имени С. В. Маракова — самый большой '
       || 'национальный парк России. В него входят все Командорские острова — Беринга, Медный, '
       || 'Топорков и Арий Камень с мелкими островками — и 30-мильная акватория Берингова моря и '
       || 'Тихого океана вокруг них: из 3,65 млн гектаров почти 3,5 млн приходится на море. '
       || 'Архипелаг лежит в 200 км к востоку от Камчатки и замыкает с запада Алеутскую островную '
       || 'дугу; высшая точка — гора Стеллера, 755 м.'
       || E'\n'
       || 'До 2022 года здесь был заповедник «Командорский», созданный 23 апреля 1993 года; в 2010-м '
       || 'ему присвоили имя Сергея Маракова, автора книги «Природа и животный мир Командор». '
       || 'Постановлением Правительства № 720 от 21 апреля 2022 года заповедник преобразовали в '
       || 'национальный парк: в его границах оказались село Никольское и земли, где живут люди, а '
       || 'режим национального парка позволяет командорским алеутам вести традиционное хозяйство. '
       || 'Границы и морская акватория при этом не изменились.'
       || E'\n'
       || 'Командоры знамениты морскими зверями. Вдоль берегов — лежбища, где собирается около 300 '
       || 'тысяч морских млекопитающих: морские котики, сивучи, ларги, каланы, тюлень Стейнегера. В '
       || 'водах парка отмечен 21 вид китообразных, и наблюдения за китами здесь ведут круглый год. '
       || 'Из наземных зверей коренной только голубой песец — двумя подвидами, беринговским и '
       || 'медновским. Только здесь жили вымершие морская корова и стеллеров баклан.'
       || E'\n'
       || 'На острове Беринга — стоянка Второй Камчатской экспедиции 1741–1742 годов и могила Витуса '
       || 'Беринга: его корабль «Святой Пётр» штормом выбросило на берег неизвестного тогда острова, '
       || 'и командор умер на вынужденной зимовке. Единственное село архипелага — Никольское на '
       || 'острове Беринга, около 600 жителей. Первыми постоянными жителями островов стали семьи '
       || 'алеутов и креолов, прибывшие в 1825–1826 годах с островов Атха и Атту.'
       || E'\n'
       || 'Климат океанический: в августе в среднем +10 °C, в феврале −4 °C, часто дуют ураганные '
       || 'ветры — больше 100 км/ч. Посещение парка платное и только по разрешению — его выдаёт отдел '
       || 'охраны национального парка в Никольском. На Командорах действует режим пограничной зоны: '
       || 'сам остров Беринга погранзоной не является, но для поездки на острова Медный, Топорков и '
       || 'Арий Камень и для любого выхода в море нужен пограничный пропуск — его оформляют на '
       || 'пограничном пункте в Никольском, гражданам России за два рабочих дня, иностранцам — до 40 '
       || 'дней.',
       access_info = 'Разрешение на посещение выдаёт отдел охраны национального парка в селе '
                  || 'Никольском (ул. 50 лет Октября, 31; по будням с 9:00 до 18:00), посещение платное. '
                  || 'Для поездки на острова Медный, Топорков и Арий Камень и для выхода в море нужен '
                  || 'пограничный пропуск — его оформляют на пограничном пункте в Никольском.',
       eco_zone = 'national_park',
       eco_permit_required = TRUE,
       -- Своей страницы разрешения нет: komandorsky.ru не отвечает (см. шапку),
       -- а Госуслуги — пропуск в погранзону, не разрешение парка.
       eco_permit_url = NULL,
       eco_rules = 'Посещение платное и только по разрешению: его выдаёт отдел охраны национального парка в селе Никольском'
                || E'\n'
                || 'Остров Беринга не входит в пограничную зону; для поездки на острова Медный, Топорков и Арий Камень и для любого выхода в море нужен пограничный пропуск'
                || E'\n'
                || 'В заповедных зонах парка запрещены любая хозяйственная деятельность и отдых'
                || E'\n'
                || 'Главный принцип парка в обращении с отходами: «Принёс — забери с собой!»',
       kuzmich_review = '',
       source_name = 'Википедия; постановление № 720 от 21.04.2022; архив сайта парка; OpenStreetMap (4176597)',
       source_url = 'http://government.ru/docs/45241/',
       updated_at = NOW()
 WHERE id::text = 'a8f3d201-5c9e-4b7a-8d63-2f1e0c4b6a35'
   AND description LIKE '%Я стоял на берегу Медного%';

WITH wanted(alias, src) AS (
  VALUES
    ('Командорский государственный природный биосферный заповедник', 'прежнее имя карточки (миграция 102)'),
    ('Командорский заповедник',                                        'OpenStreetMap, отношение 5576397'),
    ('Национальный парк «Командорские острова»',                       'постановление Правительства № 720 от 21.04.2022'),
    ('Национальный парк «Командорские острова» имени С. В. Маракова', 'Википедия'),
    ('Komandorsky Zapovednik',                                         'Викиданные Q4229211, P373')
)
INSERT INTO place_aliases (place_id, alias, source_name)
SELECT p.id::text, w.alias, w.src
  FROM wanted w
  JOIN places p ON p.id::text = 'a8f3d201-5c9e-4b7a-8d63-2f1e0c4b6a35' AND p.name = 'Командорские острова'
 WHERE p.merged_into_id IS NULL
ON CONFLICT (place_id, LOWER(TRIM(alias))) DO NOTHING;

-- Профиль: «часто дуют ураганные ветра, более 100 км/ч» (Википедия). Медведей
-- на островах нет, иных опасностей источники не называют. registration_required
-- FALSE — «не записано», см. Корякский выше.
INSERT INTO location_safety_profile
  (agent_route_id, capacity_per_day, capacity_per_hour, optimal_group_size,
   difficulty_level, sat_communicator_required, road_type, road_accessibility,
   hazard_types, registration_required, profile_source, profile_source_at)
SELECT p.ark_id, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL,
       ARRAY['weather']::text[], FALSE, 'manual', NOW()
  FROM places p
 WHERE p.id::text = 'a8f3d201-5c9e-4b7a-8d63-2f1e0c4b6a35'
   AND p.ark_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM location_safety_profile l WHERE l.agent_route_id::text = p.ark_id::text);

INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height,
                             author, license, license_url, source_url, s3_key)
SELECT p.ark_id, NULL::bytea, 'image/jpeg',
       'Wikimedia Commons: «Побережье Берингова моря» (миграция 1243)',
       'wikimedia', 1920, 1051,
       'Витюгова Женя', 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0',
       'https://commons.wikimedia.org/wiki/File:%D0%9A%D0%BE%D0%BC%D0%B0%D0%BD%D0%B4%D0%BE%D1%80%D1%81%D0%BA%D0%B8%D0%B9_%D0%B7%D0%B0%D0%BF%D0%BE%D0%B2%D0%B5%D0%B4%D0%BD%D0%B8%D0%BA._%D0%9F%D0%BE%D0%B1%D0%B5%D1%80%D0%B5%D0%B6%D1%8C%D0%B5_%D0%91%D0%B5%D1%80%D0%B8%D0%BD%D0%B3%D0%BE%D0%B2%D0%B0_%D0%BC%D0%BE%D1%80%D1%8F.jpg',
       'photos/komandorskie-ostrova/poberezhe-beringova-morya.jpg'
  FROM places p
 WHERE p.id::text = 'a8f3d201-5c9e-4b7a-8d63-2f1e0c4b6a35'
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
    (1, 1280, 960, 'Остров Медный', 'SuricataJ', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%9E._%D0%9C%D0%B5%D0%B4%D0%BD%D1%8B%D0%B9_57586.jpg',
     'photos/komandorskie-ostrova/ostrov-mednyj.jpg'),
    (2, 1280, 853, 'Морские котики на Северном лежбище', 'Витюгова Женя', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%9A%D0%BE%D0%BC%D0%B0%D0%BD%D0%B4%D0%BE%D1%80%D1%81%D0%BA%D0%B8%D0%B9_%D0%B7%D0%B0%D0%BF%D0%BE%D0%B2%D0%B5%D0%B4%D0%BD%D0%B8%D0%BA._%D0%9C%D0%BE%D1%80%D1%81%D0%BA%D0%B8%D0%B5_%D0%BA%D0%BE%D1%82%D0%B8%D0%BA%D0%B8_%D0%BD%D0%B0_%D0%A1%D0%B5%D0%B2%D0%B5%D1%80%D0%BD%D0%BE%D0%BC_%D0%BB%D0%B5%D0%B6%D0%B1%D0%B8%D1%89%D0%B5.jpg',
     'photos/komandorskie-ostrova/morskie-kotiki-na-severnom-lezhbishche.jpg'),
    (3, 1280, 853, 'Сивуч', 'Витюгова Женя', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%9A%D0%BE%D0%BC%D0%B0%D0%BD%D0%B4%D0%BE%D1%80%D1%81%D0%BA%D0%B8%D0%B9_%D0%B7%D0%B0%D0%BF%D0%BE%D0%B2%D0%B5%D0%B4%D0%BD%D0%B8%D0%BA._%D0%A1%D0%B8%D0%B2%D1%83%D1%87.jpg',
     'photos/komandorskie-ostrova/sivuch.jpg'),
    (4, 1280, 850, 'Северное лежбище', 'Витюгова Женя', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%9A%D0%BE%D0%BC%D0%B0%D0%BD%D0%B4%D0%BE%D1%80%D1%81%D0%BA%D0%B8%D0%B9_%D0%B7%D0%B0%D0%BF%D0%BE%D0%B2%D0%B5%D0%B4%D0%BD%D0%B8%D0%BA._%D0%A1%D0%B5%D0%B2%D0%B5%D1%80%D0%BD%D0%BE%D0%B5_%D0%BB%D0%B5%D0%B6%D0%B1%D0%B8%D1%89%D0%B5.jpg',
     'photos/komandorskie-ostrova/severnoe-lezhbishche.jpg'),
    (5, 1280, 720, 'Песец в феврале', 'Sergey41', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%9F%D0%B5%D1%81%D0%B5%D1%86_%D1%84%D0%B5%D0%B2%D1%80%D0%B0%D0%BB%D1%8C.jpg',
     'photos/komandorskie-ostrova/pesec.jpg'),
    (6, 1280, 853, 'Побережье Берингова моря, мыс Старогаванский', 'Витюгова Женя', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%9A%D0%BE%D0%BC%D0%B0%D0%BD%D0%B4%D0%BE%D1%80%D1%81%D0%BA%D0%B8%D0%B9_%D0%B7%D0%B0%D0%BF%D0%BE%D0%B2%D0%B5%D0%B4%D0%BD%D0%B8%D0%BA._%D0%9F%D0%BE%D0%B1%D0%B5%D1%80%D0%B5%D0%B6%D1%8C%D0%B5_%D0%91%D0%B5%D1%80%D0%B8%D0%BD%D0%B3%D0%BE%D0%B2%D0%B0_%D0%BC%D0%BE%D1%80%D1%8F,_%D0%BC%D1%8B%D1%81_%D0%A1%D1%82%D0%B0%D1%80%D0%BE%D0%B3%D0%B0%D0%B2%D0%B0%D0%BD%D1%81%D0%BA%D0%B8%D0%B9.jpg',
     'photos/komandorskie-ostrova/mys-starogavanskij.jpg'),
    (7, 1280, 960, 'Бухта Буяна', 'SuricataJ', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%91%D1%83%D1%85%D1%82%D0%B0_%D0%91%D1%83%D1%8F%D0%BD%D0%B0_1.JPG',
     'photos/komandorskie-ostrova/buhta-buyana.jpg'),
    (8, 1280, 853, 'Берингийский песочник', 'Витюгова Женя', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%9A%D0%BE%D0%BC%D0%B0%D0%BD%D0%B4%D0%BE%D1%80%D1%81%D0%BA%D0%B8%D0%B9_%D0%B7%D0%B0%D0%BF%D0%BE%D0%B2%D0%B5%D0%B4%D0%BD%D0%B8%D0%BA._%D0%91%D0%B5%D1%80%D0%B8%D0%BD%D0%B3%D0%B8%D0%B9%D1%81%D0%BA%D0%B8%D0%B9_%D0%BF%D0%B5%D1%81%D0%BE%D1%87%D0%BD%D0%B8%D0%BA.jpg',
     'photos/komandorskie-ostrova/beringijskij-pesochnik.jpg'),
    (9, 1280, 960, 'Остров Беринга летом', 'Martin Ehrensvärd', 'CC BY-SA 2.0',
     'https://creativecommons.org/licenses/by-sa/2.0',
     'https://commons.wikimedia.org/wiki/File:Isola_di_Bering_-_estate.jpg',
     'photos/komandorskie-ostrova/ostrov-beringa-letom.jpg')
)
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height,
                                  caption, author, license, license_url, source_url, s3_key)
SELECT p.ark_id, s.position, NULL::bytea, 'image/jpeg', s.width, s.height,
       s.caption, s.author, s.license, s.license_url, s.source_url, s.s3_key
  FROM shots s
  JOIN places p ON p.id::text = 'a8f3d201-5c9e-4b7a-8d63-2f1e0c4b6a35'
 WHERE p.ark_id IS NOT NULL
ON CONFLICT (ark_id, position) DO NOTHING;

-- Справочник парков: /park/komandorskiy назывался «Командорский заповедник»,
-- и его кнопка «Получить» вела на мёртвый komandorsky.ru. Каналы разрешения —
-- со страницы «Туристам» сайта парка (архив 2026).
UPDATE parks
   SET display_name = 'Национальный парк «Командорские острова»',
       description = 'Самый большой национальный парк России: острова Беринга, Медный, Топорков и '
                  || 'Арий Камень и 30-мильная акватория вокруг них. Лежбища морских котиков и '
                  || 'сивучей, каланы, киты. До 2022 года — заповедник «Командорский». Посещение '
                  || 'платное, по разрешению отдела охраны парка в Никольском; для поездки на Медный '
                  || 'и выхода в море нужен пограничный пропуск.',
       permit_url = NULL,
       permit_office_address = 'село Никольское, ул. 50 лет Октября, 31 — отдел охраны национального парка',
       permit_office_hours = 'пн–пт 9:00–18:00, обед 13:00–14:00',
       permit_email = 'ostrova.ohrana@gmail.com',
       updated_at = NOW()
 WHERE slug = 'komandorskiy'
   AND display_name = 'Командорский заповедник';

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_kor record;
  v_kom record;
  v_kor_gallery int;
  v_kom_gallery int;
BEGIN
  SELECT name, location_type, eco_zone, round(lat::numeric, 4) AS lat INTO v_kor
    FROM places WHERE id::text = 'b9c4e312-6d8f-4a5b-9c71-3e2f1d0b7a46';
  SELECT name, location_type, eco_zone, round(lat::numeric, 4) AS lat INTO v_kom
    FROM places WHERE id::text = 'a8f3d201-5c9e-4b7a-8d63-2f1e0c4b6a35';
  SELECT count(*) INTO v_kor_gallery FROM place_gallery_photos g JOIN places p ON g.ark_id = p.ark_id
   WHERE p.id::text = 'b9c4e312-6d8f-4a5b-9c71-3e2f1d0b7a46';
  SELECT count(*) INTO v_kom_gallery FROM place_gallery_photos g JOIN places p ON g.ark_id = p.ark_id
   WHERE p.id::text = 'a8f3d201-5c9e-4b7a-8d63-2f1e0c4b6a35';

  IF v_kor.name IS NULL THEN
    RAISE WARNING '[1243] Корякского заповедника (b9c4e312) нет в places';
  ELSIF v_kor.name <> 'Корякский заповедник' OR v_kor.location_type <> 'reserve' OR v_kor.eco_zone IS DISTINCT FROM 'federal_reserve' THEN
    RAISE WARNING '[1243] Корякский заповедник лёг не весь: имя «%», тип %, режим % — описание на проде не то, что видела проба 839?',
      v_kor.name, v_kor.location_type, v_kor.eco_zone;
  END IF;
  IF v_kor.lat IS DISTINCT FROM 59.8865 THEN
    RAISE WARNING '[1243] координата Корякского не заменена: широта % (ждали заглушку 60.0)', v_kor.lat;
  END IF;

  IF v_kom.name IS NULL THEN
    RAISE WARNING '[1243] Командорского (a8f3d201) нет в places';
  ELSIF v_kom.name <> 'Командорские острова' OR v_kom.location_type <> 'national_park' OR v_kom.eco_zone IS DISTINCT FROM 'national_park' THEN
    RAISE WARNING '[1243] национальный парк «Командорские острова» лёг не весь: имя «%», тип %, режим %',
      v_kom.name, v_kom.location_type, v_kom.eco_zone;
  END IF;
  IF v_kom.lat IS DISTINCT FROM 55.0216 THEN
    RAISE WARNING '[1243] координата Командорских не заменена: широта %', v_kom.lat;
  END IF;

  IF v_kor_gallery < 1 OR v_kom_gallery < 9 THEN
    RAISE WARNING '[1243] галереи: Корякский % из 1, Командорские % из 9 — позиции заняты другими?',
      v_kor_gallery, v_kom_gallery;
  END IF;
END $$;

COMMIT;
