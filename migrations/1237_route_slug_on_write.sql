-- 1237_route_slug_on_write.sql
--
-- Адрес по имени — маршруту при записи, а не миграцией раз в два месяца.
--
-- ── Повод (перепись sitemap 14.10, прогон 7) ──────────────────────────────
--
-- В sitemap 133 маршрута из 370 открываются по UUID. Адреса раздавали
-- миграции разом — 779 (июль) и 1136 (01.10), — а пишущие пути маршрута
-- (очередь треков, входящие KML, разведчик OSM, импортёры) адреса не выдают:
-- маршрут, заведённый на следующий день после бэкфилла, снова живёт по UUID.
-- 1136 сама это записала («повторный прогон подхватит маршруты, заведённые
-- после неё»), то есть объявила адрес, не заведя ему производителя (правило
-- 10.09). У туров та же дыра закрыта триггером с 1114.
--
-- ── Что делает миграция ───────────────────────────────────────────────────
--
-- 1. route_slug_candidate(id, title) — правило 1136 одной функцией. Адрес по
--    имени (translit_ru_slug, 779) получает маршрут, только если адрес
--    свободен и среди маршрутов, и среди мест, и нет второго видимого
--    маршрута без адреса с тем же именем: тёзки не делят адрес «кто первый».
--    Числового суффикса нет; адрес места маршруту не отдаётся (двойник,
--    308 на место — правило 29.09). Новое против 1136: адрес раздела
--    /routes/<раздел> (rybalka, medvedi, trekking…) и статичного сегмента
--    app/routes/tour маршрут не получает — страница раздела проверяется
--    раньше, и карточка маршрута стала бы недостижимой. Тот же список —
--    ROUTE_RESERVED_SLUGS в lib/routes/slug-census.ts; связку держит сторож
--    tests/integration/route-slug-on-write.pg.test.ts.
-- 2. Триггер выдаёт адрес по этому правилу при вставке и когда маршрут
--    становится видимым или перестаёт быть слитым (скрытые входящие KML и
--    находки разведчика открывает модерация позже). Адрес, данный писателем,
--    не трогается. Смена названия адрес не меняет: ссылки на него уже лежат
--    в выдаче (то же решение, что у туров в 1114).
--    Правило проверяется под advisory-блокировкой по адресу: две записи
--    одного имени в двух транзакциях иначе обе сочли бы адрес свободным, и
--    вторая упала бы на уникальном индексе 779 — вместе с записью маршрута.
--    Функция триггера VOLATILE (как всякая plpgsql без пометки) намеренно:
--    правило видит строки, уже записанные той же командой, и во вставке
--    нескольких строк вторая видит адрес первой. STABLE её бы не увидела,
--    и вставка упала бы на уникальном индексе — сторож это ловит.
--    route_slug_candidate VOLATILE по той же причине: на случай, если её
--    позовут прямо из многострочного UPDATE.
-- 3. Добор — тем же правилом, по одному маршруту: видимым без адреса,
--    заведённым после 1136. Правило смотрит на уже выданные адреса, а итог
--    от порядка не зависит: двое тёзок не получают адреса оба, при любом
--    порядке обхода. updated_at поднимается: у страницы новый адрес, и
--    lastmod в sitemap должен это сказать.
--
-- Остальные маршруты без адреса (тёзки, имя места, адрес у скрытого или
-- слитого дубля) правило не трогает — кого как назвать, решается по
-- переписи /api/cron/route-slug-census, а не миграцией.
--
-- Идемпотентна: функции — CREATE OR REPLACE, триггер — DROP/CREATE, добор
-- трогает только маршруты без адреса.

CREATE OR REPLACE FUNCTION route_slug_candidate(p_id uuid, p_title text) RETURNS text AS $$
DECLARE
  base text;
BEGIN
  base := translit_ru_slug(p_title);
  IF base = '' THEN
    RETURN NULL;
  END IF;
  -- Разделы /routes/<раздел> и статичный сегмент app/routes/tour. Адреса с
  -- подчёркиванием транслитерация дать не может, они здесь ради полноты списка.
  IF base = ANY (ARRAY[
    'vulkani', 'rybalka', 'termalnye_istochniki', 'geyzery', 'morskie_progulki',
    'trekking', 'vertoletnye_tury', 'medvedi', 'snegohod', 'dzhip', 'lakes',
    'mountains', 'rivers', 'eco', 'tour'
  ]) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM kamchatka_routes x WHERE x.slug = base) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM places p WHERE p.slug = base) THEN
    RETURN NULL;
  END IF;
  -- Тёзка: другой видимый и не слитый маршрут без адреса с тем же именем.
  IF EXISTS (
    SELECT 1
      FROM kamchatka_routes c
     WHERE c.id IS DISTINCT FROM p_id
       AND (c.slug IS NULL OR c.slug = '')
       AND c.is_visible = TRUE
       AND c.merged_into_id IS NULL
       AND translit_ru_slug(c.title) = base
  ) THEN
    RETURN NULL;
  END IF;
  RETURN base;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION kamchatka_routes_assign_slug() RETURNS trigger AS $$
DECLARE
  base text;
BEGIN
  IF NEW.slug IS NOT NULL AND NEW.slug <> '' THEN
    RETURN NEW;
  END IF;
  IF NEW.is_visible IS NOT TRUE OR NEW.merged_into_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  base := translit_ru_slug(NEW.title);
  IF base = '' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('kamchatka_routes.slug:' || base, 0));
  NEW.slug := route_slug_candidate(NEW.id, NEW.title);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kamchatka_routes_assign_slug ON kamchatka_routes;
CREATE TRIGGER kamchatka_routes_assign_slug
  BEFORE INSERT OR UPDATE OF is_visible, merged_into_id ON kamchatka_routes
  FOR EACH ROW EXECUTE FUNCTION kamchatka_routes_assign_slug();

DO $$
DECLARE
  r record;
  s text;
BEGIN
  FOR r IN
    SELECT id, title
      FROM kamchatka_routes
     WHERE (slug IS NULL OR slug = '')
       AND is_visible = TRUE
       AND merged_into_id IS NULL
     ORDER BY created_at, id
  LOOP
    s := route_slug_candidate(r.id, r.title);
    IF s IS NOT NULL THEN
      UPDATE kamchatka_routes
         SET slug = s,
             updated_at = NOW()
       WHERE id = r.id
         AND (slug IS NULL OR slug = '');
    END IF;
  END LOOP;
END $$;
