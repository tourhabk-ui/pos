-- 1491_place_slug_on_write.sql
--
-- Адрес по имени — месту при записи, а не миграцией раз в два месяца
-- (#3566 п.2, слово владельца «go» 21.11).
--
-- ── Повод ─────────────────────────────────────────────────────────────────
--
-- Google Search Console 19–20.11: в индексе места по UUID, например
-- /places/0b9f6ea0-… (вулкан Чикурачки, миграция 1366). Страница места уже
-- уводит 301 с UUID на адрес по имени — если адрес есть. У мест, заведённых
-- после разовой раздачи 1111 (29.09), его нет: пишущие пути (миграции мест,
-- импорт, админка) адрес не выдают, и 1111 сама это записала («повторный
-- прогон подхватит места, заведённые после»). То же было у маршрутов, и 1237
-- закрыла дыру триггером; у мест производителя адреса не было (правило 10.09:
-- объявлено без производителя).
--
-- ── Что делает миграция ───────────────────────────────────────────────────
--
-- 1. place_slug_candidate(id, name) — правило 1111 одной функцией. Адрес по
--    имени (translit_ru_slug, 779) получает место, только если адрес свободен
--    и среди мест, и среди маршрутов, и нет второго видимого не слитого места
--    без адреса с тем же именем: тёзки не делят адрес «кто первый». Служебные
--    имена «Точка маршрута…» адреса не получают. Числового суффикса нет: у
--    тёзок и у мест с адресом, занятым маршрутом, остаётся UUID — кому отдать
--    адрес, решает человек (как в 1111).
-- 2. Триггер выдаёт адрес по этому правилу при вставке и когда место
--    становится видимым или перестаёт быть слитым. Адрес, данный писателем,
--    не трогается; смена имени адрес не меняет — ссылки на него уже в выдаче.
--    Правило проверяется под той же advisory-блокировкой по адресу, что у
--    маршрутов (1237): место и маршрут одного имени в двух транзакциях иначе
--    оба сочли бы адрес свободным. Функции VOLATILE — по той же причине, что
--    в 1237 (вставка нескольких строк одной командой).
-- 3. Добор — тем же правилом, по одному месту: видимым без адреса. Итог от
--    порядка обхода не зависит: тёзки не получают адреса оба. updated_at
--    поднимается — у страницы новый адрес, lastmod в sitemap это скажет.
--
-- Идемпотентна: функции — CREATE OR REPLACE, триггер — DROP/CREATE, добор
-- трогает только места без адреса.
-- Сторож: tests/integration/route-slug-on-write.pg.test.ts (блок мест).

CREATE OR REPLACE FUNCTION place_slug_candidate(p_id text, p_name text) RETURNS text AS $$
DECLARE
  base text;
BEGIN
  IF p_name IS NULL OR p_name ILIKE 'Точка маршрута%' THEN
    RETURN NULL;
  END IF;
  base := translit_ru_slug(p_name);
  IF base = '' THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM places x WHERE x.slug = base) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM kamchatka_routes r WHERE r.slug = base) THEN
    RETURN NULL;
  END IF;
  -- Тёзка: другое видимое и не слитое место без адреса с тем же именем.
  IF EXISTS (
    SELECT 1
      FROM places c
     WHERE c.id IS DISTINCT FROM p_id
       AND (c.slug IS NULL OR c.slug = '')
       AND c.is_visible = TRUE
       AND c.merged_into_id IS NULL
       AND translit_ru_slug(c.name) = base
  ) THEN
    RETURN NULL;
  END IF;
  RETURN base;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION places_assign_slug() RETURNS trigger AS $$
DECLARE
  base text;
BEGIN
  IF NEW.slug IS NOT NULL AND NEW.slug <> '' THEN
    RETURN NEW;
  END IF;
  IF NEW.is_visible IS NOT TRUE OR NEW.merged_into_id IS NOT NULL OR NEW.name IS NULL THEN
    RETURN NEW;
  END IF;
  base := translit_ru_slug(NEW.name);
  IF base = '' THEN
    RETURN NEW;
  END IF;
  -- Ключ тот же, что у маршрутов (1237): адрес общий на места и маршруты.
  PERFORM pg_advisory_xact_lock(hashtextextended('kamchatka_routes.slug:' || base, 0));
  NEW.slug := place_slug_candidate(NEW.id, NEW.name);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS places_assign_slug ON places;
CREATE TRIGGER places_assign_slug
  BEFORE INSERT OR UPDATE OF is_visible, merged_into_id ON places
  FOR EACH ROW EXECUTE FUNCTION places_assign_slug();

DO $$
DECLARE
  r record;
  s text;
BEGIN
  FOR r IN
    SELECT id, name
      FROM places
     WHERE (slug IS NULL OR slug = '')
       AND is_visible = TRUE
       AND merged_into_id IS NULL
     ORDER BY created_at NULLS LAST, id
  LOOP
    s := place_slug_candidate(r.id, r.name);
    IF s IS NOT NULL THEN
      UPDATE places
         SET slug = s,
             updated_at = NOW()
       WHERE id::text = r.id::text
         AND (slug IS NULL OR slug = '');
    END IF;
  END LOOP;
END $$;
