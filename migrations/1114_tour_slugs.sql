-- 1114_tour_slugs.sql
--
-- Адрес по имени (ЧПУ) для туров: /catalog/tours/splav-po-reke-bystraya
-- вместо /catalog/tours/27.
--
-- ── Повод (аудит SEO 29.09, решение владельца 30.09 «ЧПУ туров») ──────────
--
-- Колонка operator_tours.slug есть с baseline, но её не пишет ни один путь
-- создания тура (кабинет оператора, импортёры, агентство): у всех туров она
-- NULL, и карточка открывается только по числу. Поисковику «27» не говорит
-- ничего, а по запросу «сплав по Быстрой» адрес не помогает.
--
-- ── Что делает миграция ───────────────────────────────────────────────────
--
-- 1. Раздаёт адрес тем же translit_ru_slug, что места и маршруты (779,
--    lib/text/slugify.ts), всем неудалённым турам без адреса. Адрес
--    уникален глобально: карточка ищет тур по одному сегменту, без
--    оператора в пути. Одноимённые туры (три «Сплава по реке Быстрая» у
--    разных операторов) голый адрес не делят «кто первый» — каждый получает
--    суффикс со своим id. Так же с адресом, который уже занят.
-- 2. Адрес никогда не состоит из одних цифр: такой сегмент карточка читает
--    как id, и тур с названием «2027» открывался бы чужим.
-- 3. Уникальный индекс по slug — гарантия, а не надежда: два тура с одним
--    адресом карточка разрешила бы наугад.
-- 4. Триггер выдаёт адрес новому туру при вставке, если писатель его не
--    дал: иначе через неделю появились бы туры снова только по числу (тот же
--    урок, что у мест после 779 — 1111 пришлось добирать).
--    Название тура потом может меняться — адрес нет: ссылки на него уже
--    лежат в выдаче и у людей. Смена адреса — отдельное решение.
--
-- Идемпотентна: трогает только slug IS NULL; индекс и триггер — IF NOT EXISTS
-- / CREATE OR REPLACE.

WITH candidates AS (
  SELECT t.id, translit_ru_slug(t.title) AS base
    FROM operator_tours t
   WHERE t.slug IS NULL
     AND t.deleted_at IS NULL
     AND t.title IS NOT NULL
),
decided AS (
  SELECT c.id,
         CASE
           WHEN c.base = '' OR c.base ~ '^[0-9]+$' THEN 'tur-' || c.id::text
           WHEN (SELECT count(*) FROM candidates c2 WHERE c2.base = c.base) > 1
             OR EXISTS (SELECT 1 FROM operator_tours x WHERE x.slug = c.base)
             THEN c.base || '-' || c.id::text
           ELSE c.base
         END AS slug
    FROM candidates c
)
UPDATE operator_tours t
   SET slug = d.slug
  FROM decided d
 WHERE t.id::text = d.id::text
   AND t.slug IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS operator_tours_slug_unique
  ON operator_tours (slug)
  WHERE slug IS NOT NULL;

CREATE OR REPLACE FUNCTION operator_tours_assign_slug() RETURNS trigger AS $$
DECLARE base TEXT;
BEGIN
  IF NEW.slug IS NOT NULL AND NEW.slug <> '' THEN
    RETURN NEW;
  END IF;
  base := translit_ru_slug(coalesce(NEW.title, ''));
  IF base = '' OR base ~ '^[0-9]+$' THEN
    NEW.slug := 'tur-' || NEW.id::text;
  ELSIF EXISTS (SELECT 1 FROM operator_tours x WHERE x.slug = base) THEN
    NEW.slug := base || '-' || NEW.id::text;
  ELSE
    NEW.slug := base;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS operator_tours_assign_slug ON operator_tours;
CREATE TRIGGER operator_tours_assign_slug
  BEFORE INSERT ON operator_tours
  FOR EACH ROW EXECUTE FUNCTION operator_tours_assign_slug();
