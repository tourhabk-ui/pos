-- 1499: «проверено: точка вне контура парка» — запись, которая сильнее
--       совпадения по имени и связи с проходящим маршрутом.
-- Created: 2026-11-22
--
-- ── Почему ───────────────────────────────────────────────────────────────
--
-- #3487, сверка 21.11: на Халактырском пляже висит «Тропы парка закрыты на
-- межсезонье», хотя пляж в природный парк не входит. Перепись путей правила
-- закрытия (park-scope-census, prod-check 207, 22.11 14:20 UTC): правило
-- считает «в парке» 156 видимых мест, у 12 из них ни контур, ни имя места
-- этого не подтверждают — в парк их ставит проходящий маршрут или совпадение
-- корня имени с названием маршрута парка.
--
-- Эти 12 сверены с контурами охраняемых территорий OpenStreetMap (выгрузка
-- Geofabrik, place-oopt-contours, прогон 3, 22.11 14:29 UTC; контроль сошёлся:
-- Долина гейзеров внутри Кроноцкого, Корякская сопка внутри «Налычево»,
-- Голая вне). Семь лежат вне контура того парка, куда их ставит правило, и
-- контуры этих трёх парков по площади сходятся с официальной (1245, 1248):
--
--   Халактырский пляж   → «Налычево»     (связь рода unknown с «Пиначево — Центральный»)
--   Авачинская бухта    → «Налычево»     (корень имени)
--   Озеро Плоское       → «Ключевской»   (корень «плоск»; карточка была красной)
--   Плоский             → «Ключевской»   (корень «плоск»; карточка была красной)
--   Озеро Глухое        → Кроноцкий      (корень имени)
--   Озеро Высокое       → Кроноцкий      (корень имени; по OSM — Тимоновский заказник)
--   Водопад Ольга       → Кроноцкий      (путевая точка 653 по совпадению имён)
--
-- Решение владельца 22.11 «вариант 1»: записать для них «вне контура», а
-- спорные места (Лавовые пещеры Горелого и Маар Медвежья чаша — контур
-- Южно-Камчатского парка в OSM неполный, 1245; Семячикский лиман — путевая
-- точка маршрута заповедника) не трогать. Ложное «закрыто» видят туристы и
-- читают ИИ-поисковики как факт о месте; снять закрытие с места, которое
-- закрыто на деле, хуже ложной тревоги — поэтому пути правила не убираются.
--
-- ── Запись привязана к точке ──────────────────────────────────────────────
--
-- Проверялась ТОЧКА места, а не место: «Водопад Ольга» стоит на 52,38° с. ш.,
-- далеко от бухты Ольга. Если координату поправят, вердикт «вне контура»
-- относится уже к другой точке. Поэтому запись хранит проверенную точку
-- (checked_lat, checked_lng), и правило читает её, только пока точка места
-- та же — поправленная координата возвращает место под обычные пути, а не
-- прячет настоящее закрытие. Связь «внутри контура» (place_park_links) того
-- же парка сильнее записи «вне» (правило: PARK_OUTSIDE_SQL).
--
-- Строка ложится, только если точка места на проде та же, что проверена
-- (допуск 1e-6 градуса); иначе — WARNING в конце, а не тишина.
--
-- ── Курильское озеро и река Хакыцын — внутри контура ──────────────────────
--
-- Обе точки внутри «Южно-Камчатского заказника» (OSM relation 5615010); в
-- закрытие заказника их ставили маршрут и корень имени. Связь по контуру —
-- та же улика, что у 1407.
--
-- place_id — TEXT без FK, как в place_park_links (1407).

BEGIN;

CREATE TABLE IF NOT EXISTS place_park_outside (
  place_id      TEXT        NOT NULL,
  park_slug     VARCHAR(64) NOT NULL REFERENCES parks (slug),
  checked_lat   NUMERIC     NOT NULL,
  checked_lng   NUMERIC     NOT NULL,
  osm_area      TEXT        NOT NULL CHECK (osm_area ~ '^(relation|way) [0-9]+$'),
  reason        TEXT        NOT NULL CHECK (length(trim(reason)) > 0),
  checked_on    DATE        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (place_id, park_slug)
);

CREATE INDEX IF NOT EXISTS idx_place_park_outside_park ON place_park_outside (park_slug);

WITH checked(slug, park_slug, lat, lng, osm_area, reason) AS (VALUES
  ('halaktyrskij-plyazh', 'nalychevo', 52.994759, 158.857237, 'relation 3978019',
   'точка вне контура «Природный парк «Налычево»»; в парк место ставила связь рода unknown с маршрутом «Пиначево — Центральный»'),
  ('avachinskaya-buhta', 'nalychevo', 52.963, 158.558, 'relation 3978019',
   'точка вне контура «Природный парк «Налычево»»; в парк место ставило совпадение корня имени с названием маршрута парка'),
  ('ozero-ploskoe', 'klyuchevskoy', 53.0990359, 158.6914942, 'relation 21624151',
   'точка вне контура «Природный парк «Ключевской»»; в парк место ставило совпадение корня «плоск» с названием маршрута парка'),
  ('ploskij', 'klyuchevskoy', 55.1891212, 158.4775085, 'relation 21624151',
   'точка вне контура «Природный парк «Ключевской»»; в парк место ставило совпадение корня «плоск» с названием маршрута парка'),
  ('ozero-gluhoe', 'kronotsky', 52.9763898, 158.2432704, 'relation 2800189',
   'точка вне контура «Кроноцкий заповедник»; в заповедник место ставило совпадение корня имени с названием маршрута'),
  ('ozero-vysokoe', 'kronotsky', 53.8924681, 158.0153038, 'relation 2800189',
   'точка вне контура «Кроноцкий заповедник» (по OSM — в Тимоновском заказнике); в заповедник место ставило совпадение корня имени'),
  ('vodopad-olga', 'kronotsky', 52.3831832, 158.0430186, 'relation 2800189',
   'точка вне контура «Кроноцкий заповедник»; в заповедник место ставили путевая точка маршрута «Бухта Ольга — Мыс Козлова» (653, совпадение имён) и корень имени; точка далеко от бухты — проверяется отдельно')
)
INSERT INTO place_park_outside (place_id, park_slug, checked_lat, checked_lng, osm_area, reason, checked_on)
SELECT p.id::text, c.park_slug, p.lat, p.lng, c.osm_area,
       c.reason || ' (OSM ' || c.osm_area || ', выгрузка Geofabrik, place-oopt-contours прогон 3)',
       DATE '2026-11-22'
  FROM checked c
  JOIN places p ON p.slug = c.slug
  JOIN parks pk ON pk.slug = c.park_slug
 WHERE abs(p.lat - c.lat::numeric) < 0.000001
   AND abs(p.lng - c.lng::numeric) < 0.000001
ON CONFLICT (place_id, park_slug) DO NOTHING;

WITH inside(slug, lat, lng) AS (VALUES
  ('kurilskoe-ozero', 51.455, 157.0983),
  ('reka-hakytsyn-sezon-medvedej', 51.5, 157.2)
)
INSERT INTO place_park_links (place_id, park_slug, reason)
SELECT p.id::text, pk.slug,
       'точка внутри контура «Южно-Камчатский заказник» (OSM relation 5615010, выгрузка Geofabrik, place-oopt-contours прогон 3, 22.11.2026)'
  FROM inside i
  JOIN places p ON p.slug = i.slug
  JOIN parks pk ON pk.slug = 'yuzhno-kamchatsky-zakaznik'
 WHERE abs(p.lat - i.lat::numeric) < 0.000001
   AND abs(p.lng - i.lng::numeric) < 0.000001
ON CONFLICT (place_id, park_slug) DO NOTHING;

-- ── Исход называется вслух ────────────────────────────────────────────────
-- Не легла строка — места нет, точка уже другая или парка нет в справочнике.
DO $$
DECLARE
  n_out int;
  n_in  int;
BEGIN
  SELECT COUNT(*)::int INTO n_out FROM place_park_outside WHERE checked_on = DATE '2026-11-22';
  SELECT COUNT(*)::int INTO n_in FROM place_park_links
   WHERE park_slug = 'yuzhno-kamchatsky-zakaznik' AND reason LIKE '%place-oopt-contours прогон 3%';
  IF n_out < 7 THEN
    RAISE WARNING '[1499] «вне контура»: строк % из 7 — места нет, точка не та или парка нет в справочнике, сверить', n_out;
  ELSE
    RAISE NOTICE '[1499] «вне контура»: строк %', n_out;
  END IF;
  IF n_in < 2 THEN
    RAISE WARNING '[1499] «внутри контура» заказника: связей % из 2, сверить', n_in;
  ELSE
    RAISE NOTICE '[1499] «внутри контура» заказника: связей %', n_in;
  END IF;
END $$;

COMMIT;

-- Rollback:
-- BEGIN;
-- DELETE FROM place_park_links WHERE park_slug = 'yuzhno-kamchatsky-zakaznik' AND reason LIKE '%place-oopt-contours прогон 3%';
-- DROP TABLE IF EXISTS place_park_outside;
-- COMMIT;
