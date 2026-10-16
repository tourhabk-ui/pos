-- 1293: Район места — по округу точки: Командоры, шесть карточек с районом
--       вне тревожных зон, 17 мест без района; строки реалтайма у видимых
--       мест, у которых их не было.
-- Created: 2026-10-16
--
-- ── Почему ───────────────────────────────────────────────────────────
--
-- Владелец 14.10: «Бери по порядку схему… делаешь без моих потверждений»;
-- 15.10: «по остальным местам там много неправды». `places.zone` на карточке
-- — строка «Район», а для безопасности — адрес: предупреждение без своей
-- координаты (ветер Росгидромета, «по всему краю» МЧС, паводок по округу)
-- ложится на место по нему (зональная ветка ALERT_MATCH_SQL,
-- lib/services/safety/alert-place-scope.ts). Тревожных зон четыре
-- (avachinsky, eastern, western, northern); район вне них зональных тревог не
-- получает вовсе, и карточка стоит «спокойной», хотя проверить её было нечем.
--
-- Перепись охвата place-zone-census (проба 971, 15.10), 384 видимых места:
--   • девять точек на острове Беринга — восемь с районом «avachinsky» и одна
--     без района. Карточка называла Командоры «Авачинским», и тревоги
--     Петропавловска и Елизова ложились на остров за 750 км;
--   • шесть карточек с районом вне четвёрки: central 2, southern 2,
--     kronotsky 1, south 1 — ни одной зональной тревоги;
--   • 22 места без района вовсе;
--   • 31 видимое место без строки реалтайма: тревог такая карточка не
--     получает никаких, какой бы ни была зона (крон пишет их в эту строку).
--
-- ── Источник района ───────────────────────────────────────────────────
--
-- Муниципальный округ точки карточки — обратным геокодированием Nominatim
-- (OpenStreetMap, zoom 8; пробы 974 и 975). Округ → зона — той же картой
-- округов, по которой зону получает сама тревога МЧС (MCHS_DISTRICT_ZONES,
-- lib/services/safety/seismic-parser.ts): Петропавловск и Елизовский —
-- avachinsky, Быстринский и Усть-Большерецкий — western. Иначе место и
-- тревога об одном округе называли бы его разными зонами и не встречались.
-- Командоры — по рамке островов, которой их тревоги находят места по
-- координате (COMMANDER_BOX, lib/safety/krai-far.ts): других земель в ней нет.
--
-- Исключения названы:
--   • Кроноцкий заповедник — точка в Елизовском районе по OSM, но район ему
--     eastern: так названы его места (справочник парков, 781) и так приём
--     адресует тексты о нём («кроноцк» и вулкан Кроноцкий → eastern).
--     Елизовские сводки МЧС говорят о Елизове и Паратунке, а не о заповеднике
--     за 200 км;
--   • Корякский заповедник — Олюторский район, дальний северный округ. Район
--     не ставится: «northern» привёл бы к нему тревоги Мильково и
--     Усть-Камчатска за 500 км. Тревоги Корякского округа и всего края
--     находят его по координате (lib/safety/krai-far.ts), как только у него
--     есть строка реалтайма (раздел 4). Чем называть район дальних округов у
--     всех 31 места севернее 57° — отдельная партия;
--   • Кекур Чёртов палец и Кенотаф крейсера «Ниитака» — точки в воде, округа
--     у них нет (Nominatim без county). Стоянка «Столик» у горы Копыто —
--     Nominatim ответил 429. Остаются без района: догадка по соседям —
--     не источник.
--
-- ── Подпись ───────────────────────────────────────────────────────────
--
-- Вместе с правкой меняется подпись западной и восточной зон: «Западная
-- Камчатка» и «Восточная Камчатка» вместо «…побережье» (lib/places/
-- zone-labels.ts, lib/safety/zone-names.ts). В западную зону приём кладёт
-- и Быстринский округ, и «Западное побережье» на карточке Эссо и Апапельских
-- источников было бы неправдой.
--
-- ── Строки реалтайма ─────────────────────────────────────────────────
--
-- Новая строка — «не знаем», а не «открыто и спокойно»: is_open и
-- recommender_status — NULL, хотя у колонок умолчания TRUE и 'green'.
-- Закрытым NULL не читает никто (карточка, карта, Кузьмич закрывают только
-- по FALSE), а цвет NULL карточка показывает словами «Обстановку сейчас не
-- знаем» — до ближайшего прогона safety-ingest, который пересчитывает
-- цвет у каждой строки (LEFT JOIN по всем строкам, раз в 5 минут).
--
-- Только поверх прежнего значения: каждая правка проверяет, что в строке
-- то, что видела перепись. Выправленное рукой после переписи не трогается.

BEGIN;

-- ── 1. Командоры: остров Беринга ──────────────────────────────────────
-- Рамка — COMMANDER_BOX (lib/safety/krai-far.ts): 54,3–55,6 с. ш.,
-- 165,5–168,2 в. д.
UPDATE places
   SET zone = 'commander', updated_at = NOW()
 WHERE id::text IN (
         'a8f3d201-5c9e-4b7a-8d63-2f1e0c4b6a35',  -- Командорские острова (района не было)
         'ac0321fc-eae0-4919-9c7c-256bbc927a1a',  -- Бакланьи камни
         '583c8f78-d82d-4021-8b59-84c8616065b0',  -- Дом дьякона
         'b36757f9-7bb3-4d10-adff-ab70b75be309',  -- Погибший баркас
         'd5e1e9c0-175e-4b24-adb7-3adae4905979',  -- Северное лежбище морских млекопитающих
         '27c04946-ede8-40e6-88ce-af25cfe1a462',  -- Северо-Западное лежбище морских млекопитающих
         '4c6fc28d-9158-4e9a-8889-f4a817406b85',  -- Уездный суд
         'd851e5bb-e21a-4a07-90b2-165969fe34a8',  -- Фактория компании «Гутчинсон, Кооль и Ко»
         'bf9f9464-7a31-4351-b654-7ca278e5401f'   -- Чёртова яма
       )
   AND (zone IS NULL OR zone = 'avachinsky')
   AND lat::float8 BETWEEN 54.3 AND 55.6
   AND lng::float8 BETWEEN 165.5 AND 168.2;

-- ── 2. Шесть карточек с районом вне тревожных зон ─────────────────────
UPDATE places p
   SET zone = v.zone_to, updated_at = NOW()
  FROM (VALUES
    -- Быстринский муниципальный округ (проба 974)
    ('c35c5024-238f-44ec-85f6-c31127fdfffb', 'central',   'western'),     -- Природный парк «Быстринский»
    ('b2c3d4e5-f6a7-8901-bcde-f01234567890', 'central',   'western'),     -- Шаманская поляна у Эссо
    -- Елизовский район (проба 974)
    ('d9059e8a-4c59-4baf-9be5-cae2fa33f810', 'southern',  'avachinsky'),  -- Парк «Южно-Камчатский»
    ('a79c9a19-e5c6-4d99-9134-cae496430dca', 'southern',  'avachinsky'),  -- Южно-Камчатский заказник
    ('a1b2c3d4-e5f6-7890-abcd-ef0123456789', 'south',     'avachinsky'),  -- Вулкан Ходутка
    -- Елизовский район по OSM; район — как у мест заповедника (см. шапку)
    ('4f1217e7-31a4-4d21-bc98-3d46aaba122e', 'kronotsky', 'eastern')      -- Кроноцкий заповедник
  ) AS v(id, zone_from, zone_to)
 WHERE p.id::text = v.id
   AND p.zone = v.zone_from;

-- ── 3. Семнадцать мест без района ─────────────────────────────────────
UPDATE places p
   SET zone = v.zone_to, updated_at = NOW()
  FROM (VALUES
    -- Быстринский муниципальный округ
    ('f3a1c9d2-7b45-4e18-9c62-a80417d5b906', 'western'),     -- Апапельские горячие источники
    -- Усть-Большерецкий муниципальный округ
    ('0d08e60d-838b-411c-bfa5-fdb7c40d8609', 'western'),     -- Водопад Снежный барс
    ('15a9e853-29b1-47f3-a12f-58f8f22f7b7a', 'western'),     -- Река Амчигача
    -- городской округ Петропавловск-Камчатский
    ('cd697b44-1eac-4e65-9463-5ac76ce34ee9', 'avachinsky'),  -- Бухта Пионерская
    ('dac787de-8f88-4ae1-8711-27b44382139b', 'avachinsky'),  -- Камчатский камень
    ('b3c4d5e6-f7a8-4901-cdef-012345678901', 'avachinsky'),  -- Камчатский краевой объединённый музей
    ('c4d5e6f7-a8b9-4012-defa-123456789012', 'avachinsky'),  -- Памятник Витусу Берингу
    ('378b4fc8-1c95-4b0d-ac4d-6ebdddb26e2e', 'avachinsky'),  -- Халактырское озеро
    -- Елизовский район
    ('cb7ef609-8912-4a13-987a-99f29f09b82a', 'avachinsky'),  -- Водопад Бабий камень
    ('97cfb6c3-703b-4d29-acf5-2eed3901a078', 'avachinsky'),  -- Вулкан Арик
    ('f31f3774-65d4-47b7-a03e-4e3d4a575100', 'avachinsky'),  -- Зеленовские озерки
    ('7c1f0a53-2f4e-4c7a-9b6d-0e5a1d8c4b21', 'avachinsky'),  -- Камчатский медведь (Здесь начинается Россия)
    ('c5b351d0-7989-ea6b-5d79-baedd9a1a996', 'avachinsky'),  -- Кордон «Авачинский»
    ('719b7a73-2e99-515a-3cca-7c36748df3b2', 'avachinsky'),  -- Старт маршрута Вачкажец (лыжный)
    ('ce16faff-a43c-89bf-a665-9ac7221eb263', 'avachinsky'),  -- Старт маршрута Вачкажец (снегоходный)
    ('fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf', 'avachinsky'),  -- Урочище Аквариум
    ('48462267-c7c8-4500-8c5c-1a9b47cdb435', 'avachinsky')   -- Чёртов мост
  ) AS v(id, zone_to)
 WHERE p.id::text = v.id
   AND p.zone IS NULL;

-- ── 4. Строки реалтайма ───────────────────────────────────────────────
-- «Не знаем» до прогона safety-ingest — не умолчания TRUE и 'green'.
INSERT INTO location_real_time_status (agent_route_id, is_open, recommender_status)
SELECT p.ark_id, NULL, NULL
  FROM places p
 WHERE p.is_visible = TRUE
   AND p.merged_into_id IS NULL
   AND p.ark_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM location_real_time_status s WHERE s.agent_route_id = p.ark_id)
ON CONFLICT (agent_route_id) DO NOTHING;

-- ── Сверка ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_commander  int;
  v_outside    int;
  v_null       int;
  v_no_status  int;
  v_no_ark     int;
BEGIN
  SELECT count(*) INTO v_commander FROM places
   WHERE is_visible AND merged_into_id IS NULL AND zone = 'commander';
  SELECT count(*) INTO v_outside FROM places
   WHERE is_visible AND merged_into_id IS NULL
     AND zone IS NOT NULL AND zone NOT IN ('avachinsky', 'eastern', 'western', 'northern', 'commander');
  SELECT count(*) INTO v_null FROM places
   WHERE is_visible AND merged_into_id IS NULL AND zone IS NULL;
  SELECT count(*) INTO v_no_status FROM places p
   WHERE p.is_visible AND p.merged_into_id IS NULL AND p.ark_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM location_real_time_status s WHERE s.agent_route_id = p.ark_id);
  -- Без ark_id строки реалтайма не завести: связь идёт по нему (FK на
  -- places.ark_id). Такие места называются числом, а не прячутся.
  SELECT count(*) INTO v_no_ark FROM places
   WHERE is_visible AND merged_into_id IS NULL AND ark_id IS NULL;

  IF v_no_status > 0 THEN
    RAISE WARNING '[1293] у % видимых мест с ark_id так и нет строки реалтайма', v_no_status;
  END IF;
  IF v_no_ark > 0 THEN
    RAISE WARNING '[1293] у % видимых мест нет ark_id — строки реалтайма у них не будет, тревог тоже', v_no_ark;
  END IF;
  RAISE NOTICE '[1293] Командоры %, район вне зон %, без района %, без строки реалтайма %, без ark_id %',
    v_commander, v_outside, v_null, v_no_status, v_no_ark;
END $$;

COMMIT;

-- Rollback (вернуть районы переписи; строки реалтайма не удаляются — они
-- «не знаем», и тревоги без них не доходят до карточки):
-- BEGIN;
-- UPDATE places SET zone = 'avachinsky' WHERE zone = 'commander' AND id::text IN (
--   'ac0321fc-eae0-4919-9c7c-256bbc927a1a', '583c8f78-d82d-4021-8b59-84c8616065b0',
--   'b36757f9-7bb3-4d10-adff-ab70b75be309', 'd5e1e9c0-175e-4b24-adb7-3adae4905979',
--   '27c04946-ede8-40e6-88ce-af25cfe1a462', '4c6fc28d-9158-4e9a-8889-f4a817406b85',
--   'd851e5bb-e21a-4a07-90b2-165969fe34a8', 'bf9f9464-7a31-4351-b654-7ca278e5401f');
-- UPDATE places SET zone = NULL WHERE zone = 'commander' AND id::text = 'a8f3d201-5c9e-4b7a-8d63-2f1e0c4b6a35';
-- UPDATE places p SET zone = v.zone_from FROM (VALUES
--   ('c35c5024-238f-44ec-85f6-c31127fdfffb', 'central'), ('b2c3d4e5-f6a7-8901-bcde-f01234567890', 'central'),
--   ('d9059e8a-4c59-4baf-9be5-cae2fa33f810', 'southern'), ('a79c9a19-e5c6-4d99-9134-cae496430dca', 'southern'),
--   ('a1b2c3d4-e5f6-7890-abcd-ef0123456789', 'south'), ('4f1217e7-31a4-4d21-bc98-3d46aaba122e', 'kronotsky')
-- ) AS v(id, zone_from) WHERE p.id::text = v.id;
-- (17 мест раздела 3 — zone = NULL по тому же списку.)
-- COMMIT;
