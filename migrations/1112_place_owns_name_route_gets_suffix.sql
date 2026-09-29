-- 1112_place_owns_name_route_gets_suffix.sql
--
-- Адрес по имени принадлежит месту; маршрут к нему получает свой.
--
-- ── Решение владельца (29.09) ─────────────────────────────────────────────
--
-- После 1111 без адреса осталось 27 видимых мест. Перепись
-- `place-slug-census` (prod-check run 72, 29.09) назвала держателя каждого:
-- у 25 адрес по имени занимает МАРШРУТ-тёзка — 7 живых (Ксудач, Толбачик,
-- Курильское озеро, Скалы Три Брата, Дачные, Карымшинские и Нальчевские
-- источники) и 18 скрытых, которые снаружи отвечают 404 и потому выглядели
-- свободными. Ещё 2 — «Точка маршрута (начало)», их миграция не трогает.
-- Догадку «адрес держит скрытый дубль места» перепись опровергла: мест-
-- держателей нет ни одного. На вопрос «кому отдать
-- `vulkan-ksudach`» владелец ответил: «к одному месту можно прийти разными
-- путями и маршрутами». Место одно, маршрутов к нему много — значит имя
-- места принадлежит месту, а маршрут — один из путей к нему (§4.1, §9).
--
-- ── Что делает миграция ───────────────────────────────────────────────────
--
-- По ПРАВИЛУ, а не по списку, для видимого и не слитого места без адреса,
-- чей адрес по имени (`translit_ru_slug`, как в 779 и 1111) держит маршрут,
-- а не другое место:
--   1. маршрут получает адрес `<имя>-marshrut` — только если он свободен и
--      среди маршрутов, и среди мест;
--   2. место получает освободившийся адрес по имени.
-- Если хоть одно условие не выполнено (суффикс занят, на адрес два
-- претендента, адрес держит место) — не трогается ни маршрут, ни место.
--
-- Старый адрес маршрута `/routes/vulkan-ksudach` проиндексирован. После
-- миграции он найдёт место и ответит 308 на `/places/vulkan-ksudach` —
-- механизм двойников 29.09 (`app/routes/[id]/page.tsx`). С карточки места
-- маршрут виден в блоке «Маршруты» под новым адресом: человек, пришедший
-- по старой ссылке, попадает к месту, а оттуда — ко всем путям к нему.
--
-- Идемпотентна: второй прогон не находит мест без адреса с маршрутом-
-- держателем.

WITH candidates AS (
  SELECT p.id::text AS place_id, translit_ru_slug(p.name) AS base
    FROM places p
   WHERE p.slug IS NULL
     AND p.is_visible = TRUE
     AND p.merged_into_id IS NULL
     AND p.name IS NOT NULL
     AND p.name NOT ILIKE 'Точка маршрута%'
),
movable AS (
  SELECT c.place_id, c.base, r.id::text AS route_id, c.base || '-marshrut' AS route_slug
    FROM candidates c
    JOIN kamchatka_routes r ON r.slug = c.base
   WHERE c.base <> ''
     -- адрес держит маршрут, а не место
     AND NOT EXISTS (SELECT 1 FROM places x WHERE x.slug = c.base)
     -- на адрес один претендент среди мест
     AND (SELECT count(*) FROM candidates c2 WHERE c2.base = c.base) = 1
     -- суффиксный адрес свободен везде
     AND NOT EXISTS (SELECT 1 FROM kamchatka_routes r2 WHERE r2.slug = c.base || '-marshrut')
     AND NOT EXISTS (SELECT 1 FROM places x2 WHERE x2.slug = c.base || '-marshrut')
),
routes_moved AS (
  UPDATE kamchatka_routes r
     SET slug = m.route_slug,
         updated_at = NOW()
    FROM movable m
   WHERE r.id::text = m.route_id::text
     AND r.slug = m.base
  RETURNING m.place_id, m.base
)
UPDATE places p
   SET slug = rm.base
  FROM routes_moved rm
 WHERE p.id::text = rm.place_id::text
   AND p.slug IS NULL;
