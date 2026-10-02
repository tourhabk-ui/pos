-- 1136_route_slugs_backfill.sql
--
-- Адрес по имени (ЧПУ) для видимых маршрутов, у которых его нет.
--
-- ── Повод (аудит vedarai.ru 01.10) ────────────────────────────────────────
--
-- В sitemap около 140 маршрутов открываются по UUID: /routes/1f0c…-… вместо
-- адреса по имени. Поисковику такой адрес ничего не говорит, а карточка
-- маршрута, найденная по UUID, ещё и уводит 308 на ЧПУ, когда он появится.
-- Причина та же, что у мест в 1111: адреса раздала миграция 779 разом, а
-- маршруты, заведённые после неё, адреса от пишущих путей не получают.
--
-- ── Что делает миграция ───────────────────────────────────────────────────
--
-- То же правило, что 1111 для мест, тем же `translit_ru_slug` (779,
-- lib/text/slugify.ts): только видимому и не слитому маршруту, только если
-- адрес свободен и среди маршрутов, и среди мест, и только если его не
-- претендует получить другой маршрут из того же прогона. Двое тёзок
-- остаются по UUID оба — делить адрес «кто первый» нельзя.
--
-- Адрес, занятый местом, маршруту НЕ отдаётся: маршрут с адресом видимого
-- места — двойник, и /routes/<адрес> уводил бы 308 на место (правило
-- двойников 29.09). Числового суффикса нет по той же причине, что в 1111:
-- он выглядел бы как починка, не будучи ею.
--
-- Идемпотентна: трогает только slug IS NULL. Повторный прогон подхватит
-- маршруты, заведённые после неё.

WITH candidates AS (
  SELECT r.id, translit_ru_slug(r.title) AS base
    FROM kamchatka_routes r
   WHERE r.slug IS NULL
     AND (r.is_visible = TRUE OR r.is_visible IS NULL)
     AND r.merged_into_id IS NULL
     AND r.title IS NOT NULL
),
usable AS (
  SELECT c.id, c.base
    FROM candidates c
   WHERE c.base <> ''
     AND NOT EXISTS (SELECT 1 FROM kamchatka_routes x WHERE x.slug = c.base)
     AND NOT EXISTS (SELECT 1 FROM places p WHERE p.slug = c.base)
     -- двое претендентов на один адрес — не получает никто
     AND (SELECT count(*) FROM candidates c2 WHERE c2.base = c.base) = 1
)
UPDATE kamchatka_routes r
   SET slug = u.base
  FROM usable u
 WHERE r.id::text = u.id::text
   AND r.slug IS NULL;
