-- 1492_geyser_valley_route_merge_kronoki.sql
--
-- Долина гейзеров: два маршрута одного места — в один, факты — с сайта
-- Кроноцкого заповедника (#3566 п.1; слово владельца 21.11: «гейзеры конечно
-- лучше факты из официального источника кроноцкого заповедника»).
--
-- ── Повод ─────────────────────────────────────────────────────────────────
--
-- Google Search Console 19–20.11: Долина гейзеров в выдаче тремя адресами —
-- место /places/dolina-gejzerov, маршруты /routes/dolina-geyzerov-385d1c98 и
-- /routes/geyzery-kamchatki. Место — точка, маршрут — путь (§4.1): место
-- остаётся. Два маршрута описывают одну экскурсию по настилам и спорят друг с
-- другом: «более 40 гейзеров» и «более 20 крупных», Великан «до 30 м» и
-- «до 35 м», площадь «около 6 кв. км».
--
-- ── Что говорит заповедник (сверено 21.11.2026) ───────────────────────────
--
--   https://kronoki.ru/ru/kamchatka/kamchatka-objects/367.html
--     «каньон (ущелье) шириной до 4 км, глубиной 400 м и длиной 8 км, по
--     которому протекает река Гейзерная»; «на протяжении 6 км от устья реки
--     сосредоточено около 60 гейзеров»; открыта 25 июля 1941 г.
--     Т. И. Устиновой и лаборантом А. П. Крупениным.
--   https://kronoki.ru/ru/visit/information-for-all/excursions/147.html
--     «более 30 крупных гейзеров»; вертолётом с аэродромов у Елизово, полёт
--     около часа; «настильные тропы общей протяженностью 1 км»; в долине
--     2–2,5 часа; на маршруте сопровождает государственный инспектор;
--     в мае и июне — ограничения.
--   https://kronoki.ru/ (главная): «единственное в Евразии».
--
-- Высоты Великана на этих страницах нет — в описании её нет. «6 км» у
-- заповедника — протяжённость вдоль реки, а не площадь. Сезон маршрута уже
-- сверен с заповедником миграцией 1385 и не трогается.
--
-- ── Что делает миграция ───────────────────────────────────────────────────
--
-- 1. «Гейзеры Камчатки» сливается в «Долину гейзеров» (-385d1c98) по образцу
--    882: путевые точки доезжают, туры перевешиваются, слитая запись
--    скрывается и получает merged_into_id. Трек не переезжает: у слитой
--    записи набор 1520 м на тропе в километр — её линия не доказательство.
--    Адрес слитой записи ведёт 308 на выжившую (app/routes/[id]/page.tsx,
--    resolveMergedRoute).
-- 2. Описание выжившей — только факты заповедника со ссылкой; прежнее
--    описание сменяется, только если стоит ровно оно (по началу текста).
--    Запись в журнал происхождения (911).
-- 3. Дистанция — 1 км по настилам (было 1,4 км без источника).
--
-- Идемпотентна: каждый шаг — по guard'ам (merged_into_id IS NULL, точное
-- начало прежнего текста, прежняя дистанция).

-- ── 1. Слияние ────────────────────────────────────────────────────────────
INSERT INTO route_waypoints (route_id, place_id, position, link_kind, link_kind_at)
SELECT l.id, rw.place_id,
       COALESCE((SELECT MAX(x.position) FROM route_waypoints x WHERE x.route_id::text = l.id::text), 0)
         + ROW_NUMBER() OVER (ORDER BY rw.position),
       rw.link_kind, rw.link_kind_at
FROM kamchatka_routes h
JOIN kamchatka_routes l ON l.slug = 'dolina-geyzerov-385d1c98' AND l.merged_into_id IS NULL
JOIN route_waypoints rw ON rw.route_id::text = h.id::text
WHERE h.slug = 'geyzery-kamchatki'
  AND h.merged_into_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM route_waypoints x
    WHERE x.route_id::text = l.id::text AND x.place_id::text = rw.place_id::text
  )
ON CONFLICT (route_id, place_id) DO NOTHING;

UPDATE operator_tours t
SET route_id = l.id
FROM kamchatka_routes h, kamchatka_routes l
WHERE h.slug = 'geyzery-kamchatki'
  AND h.merged_into_id IS NULL
  AND l.slug = 'dolina-geyzerov-385d1c98'
  AND l.merged_into_id IS NULL
  AND t.route_id::text = h.id::text;

UPDATE kamchatka_routes h
SET is_visible = false,
    merged_into_id = l.id::text,
    merged_at = NOW(),
    updated_at = NOW()
FROM kamchatka_routes l
WHERE h.slug = 'geyzery-kamchatki'
  AND h.merged_into_id IS NULL
  AND l.slug = 'dolina-geyzerov-385d1c98'
  AND l.merged_into_id IS NULL;

-- ── 2. Описание — факты заповедника ───────────────────────────────────────
WITH old AS (
  SELECT id, LENGTH(description) AS prev_chars
    FROM kamchatka_routes
   WHERE slug = 'dolina-geyzerov-385d1c98'
     AND description LIKE 'Долина гейзеров — одно из самых впечатляющих мест Камчатки%'
),
upd AS (
  UPDATE kamchatka_routes r
     SET description = 'Долина гейзеров — каньон реки Гейзерной в Кроноцком заповеднике: ширина до 4 км, глубина 400 м, длина 8 км. На протяжении 6 км от устья реки сосредоточено около 60 гейзеров и множество термальных источников, крупных гейзеров — более 30. Это единственное гейзерное поле в Евразии. Долину открыли 25 июля 1941 года научный сотрудник заповедника Т. И. Устинова и лаборант А. П. Крупенин.'
                       || E'\n\n'
                       || 'Добраться можно только вертолётом — с аэродромов у Елизово или с других вертолётных площадок, полёт около часа. Экскурсия идёт по настильным тропам общей протяжённостью около 1 км, в долине группа проводит 2–2,5 часа, на маршруте сопровождает государственный инспектор заповедника. Туры в долину организуют туроператоры Камчатского края. В мае и июне на маршруте вводятся ограничения — о режиме узнают заранее.'
                       || E'\n\n'
                       || 'Источник: Кроноцкий заповедник, kronoki.ru — «Всё о Долине гейзеров» и «Гейзеры Кроноцкого заповедника», сверено 21.11.2026.',
         updated_at = NOW()
    FROM old
   WHERE r.id::text = old.id::text
  RETURNING COALESCE(r.ark_id, r.id) AS entity_id, r.title, r.description, old.prev_chars
)
INSERT INTO description_provenance
  (entity_id, entity_kind, entity_title, written_by, facts_given, facts_count, chars, previous_chars)
SELECT
  upd.entity_id,
  'route',
  upd.title,
  'fact-correction',
  '["каньон шириной до 4 км, глубиной 400 м, длиной 8 км (kronoki.ru 367.html)","около 60 гейзеров на 6 км от устья реки (kronoki.ru 367.html)","более 30 крупных гейзеров (kronoki.ru 147.html)","единственное в Евразии (kronoki.ru, главная)","открыта 25.07.1941 Т. И. Устиновой и А. П. Крупениным (kronoki.ru 367.html)","вертолёт, полёт около часа (kronoki.ru 147.html)","настильные тропы около 1 км, 2–2,5 часа в долине (kronoki.ru 147.html)","сопровождает государственный инспектор (kronoki.ru 147.html)","туры организуют туроператоры края (kronoki.ru 147.html)","ограничения в мае и июне (kronoki.ru 147.html)"]'::jsonb,
  10,
  LENGTH(upd.description),
  upd.prev_chars
FROM upd;

-- ── 3. Дистанция — по настилам заповедника ────────────────────────────────
UPDATE kamchatka_routes
SET distance_km = 1,
    distance_note = 'по настилам',
    updated_at = NOW()
WHERE slug = 'dolina-geyzerov-385d1c98'
  AND distance_km = 1.4;
