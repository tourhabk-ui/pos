-- 1238_route_marshrut_and_hidden_twin.sql
--
-- Маршрут с именем места — `<имя>-marshrut`; адрес скрытого маршрута-тёзки —
-- видимому. Решение владельца 14.10 по переписи `route-slug-census`.
--
-- ── Повод (перепись на проде 14.10, 02:31 UTC) ────────────────────────────
--
-- После 1237 по UUID осталось 133 видимых маршрута: правило записи адреса им
-- не выдало ни одного, потому что адрес по имени у каждого кем-то занят.
-- Все 133 — одна партия скрейпа 12.07, у каждого линия (`external`), имя у
-- 132 совпадает с держателем буква в букву:
--   — у 125 адрес держит МЕСТО: видимое (89), слитое (19) или скрытое (17);
--   — у 8 — СКРЫТЫЙ маршрут-тёзка (Налычевское кольцо, Сплав по реке
--     Быстрая…).
--
-- О таких маршрутах есть два решения владельца, и 14.10 он выбрал между ними:
--   — 15.08, ровно об этих записях: «не скрывать, а дооформить» — у них
--     настоящие треки, им дописали дистанцию и связали с местами;
--   — 29.09 (миграция 1112): «к одному месту можно прийти разными путями и
--     маршрутами» — имя принадлежит месту, маршрут к нему — `<имя>-marshrut`.
--   Выбор 14.10: «<имя>-marshrut» и «передать видимому». Редирект на карточку
--   места (как у 218 пар с ОДИНАКОВЫМ адресом, 29.09) отвергнут: карточка с
--   треком туристу больше не открывалась бы.
--
-- ── Что делает миграция ───────────────────────────────────────────────────
--
-- 1. route_slug_candidate — правило 1237 плюс ветка места: адрес по имени
--    держит место (любое — видимое, скрытое или слитое) — маршрут получает
--    `<имя>-marshrut`, если тот свободен и среди маршрутов, и среди мест. Тёзки
--    по-прежнему не делят адрес «кто первый»: двое без адреса с одним именем
--    не получают ни имени, ни суффикса. Адрес, который держит МАРШРУТ,
--    правило не трогает. Так же поступает и триггер 1237 на новых маршрутах —
--    правило одно; блокировка берётся на обе формы адреса, иначе маршрут с
--    именем «X маршрут» и маршрут к месту X в двух транзакциях сочли бы
--    `x-marshrut` свободным оба.
-- 2. Разово, только в этой миграции: адрес по имени, который держит СКРЫТЫЙ и
--    не слитый маршрут, переходит видимому тёзке без адреса — если тот один
--    такой и адрес не держит место. Скрытый адрес никого не ведёт (его
--    страница отвечает 404), а видимый маршрут с тем же именем стоял по UUID.
--    Скрытый остаётся без адреса; станет видимым — правило выдаст ему адрес,
--    если тот свободен. В триггер этот перенос НЕ входит: скрытый маршрут
--    может быть скрыт на время модерации, и отнимать у него адрес на каждой
--    вставке тёзки — решение, которого владелец не давал.
-- 3. Добор — тем же правилом, по одному маршруту, как в 1237.
--
-- Без адреса остаются те, где и суффикс занят («Зеленовские озерки»: у
-- `zelenovskie-ozerki-marshrut` уже есть хозяин) и тёзки без адреса — их
-- называет перепись `route-slug-census`.
--
-- Идемпотентна: функция — CREATE OR REPLACE, триггер — DROP/CREATE, перенос и
-- добор трогают только видимые маршруты без адреса.

CREATE OR REPLACE FUNCTION route_slug_candidate(p_id uuid, p_title text) RETURNS text AS $$
DECLARE
  base text;
  suffixed text;
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
  -- Тёзка: другой видимый и не слитый маршрут без адреса с тем же именем. Не
  -- получает никто — ни имени, ни суффикса.
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
  -- Адрес держит маршрут — правило его не трогает.
  IF EXISTS (SELECT 1 FROM kamchatka_routes x WHERE x.slug = base) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM places p WHERE p.slug = base) THEN
    RETURN base;
  END IF;
  -- Имя принадлежит месту — маршрут к нему: `<имя>-marshrut` (1112, 14.10).
  suffixed := base || '-marshrut';
  IF EXISTS (SELECT 1 FROM kamchatka_routes x WHERE x.slug = suffixed)
     OR EXISTS (SELECT 1 FROM places p WHERE p.slug = suffixed) THEN
    RETURN NULL;
  END IF;
  RETURN suffixed;
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
  -- Обе формы адреса, которые правило может выдать: имя и имя с суффиксом.
  PERFORM pg_advisory_xact_lock(hashtextextended('kamchatka_routes.slug:' || base, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('kamchatka_routes.slug:' || base || '-marshrut', 0));
  NEW.slug := route_slug_candidate(NEW.id, NEW.title);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kamchatka_routes_assign_slug ON kamchatka_routes;
CREATE TRIGGER kamchatka_routes_assign_slug
  BEFORE INSERT OR UPDATE OF is_visible, merged_into_id ON kamchatka_routes
  FOR EACH ROW EXECUTE FUNCTION kamchatka_routes_assign_slug();

-- 2. Адрес скрытого маршрута-тёзки — видимому (разово).
DO $$
DECLARE
  m record;
BEGIN
  FOR m IN
    SELECT r.id AS route_id, h.id AS holder_id, h.slug AS base
      FROM kamchatka_routes r
      JOIN kamchatka_routes h ON h.slug = translit_ru_slug(r.title)
     WHERE (r.slug IS NULL OR r.slug = '')
       AND r.is_visible = TRUE
       AND r.merged_into_id IS NULL
       AND h.is_visible = FALSE
       AND h.merged_into_id IS NULL
       AND h.id::text <> r.id::text
       AND NOT EXISTS (SELECT 1 FROM places p WHERE p.slug = h.slug)
       -- видимый претендент один
       AND NOT EXISTS (
         SELECT 1
           FROM kamchatka_routes c
          WHERE c.id::text <> r.id::text
            AND (c.slug IS NULL OR c.slug = '')
            AND c.is_visible = TRUE
            AND c.merged_into_id IS NULL
            AND translit_ru_slug(c.title) = h.slug
       )
     ORDER BY r.created_at, r.id
  LOOP
    UPDATE kamchatka_routes
       SET slug = NULL,
           updated_at = NOW()
     WHERE id::text = m.holder_id::text
       AND slug = m.base;
    UPDATE kamchatka_routes
       SET slug = m.base,
           updated_at = NOW()
     WHERE id::text = m.route_id::text
       AND (slug IS NULL OR slug = '');
  END LOOP;
END $$;

-- 3. Добор тем же правилом.
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
       WHERE id::text = r.id::text
         AND (slug IS NULL OR slug = '');
    END IF;
  END LOOP;
END $$;
