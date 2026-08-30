-- 918: «Зеленовские озерки» — маршрут был, места не было.
--
-- Живой скрин владельца 30.08: поиск цели «зел» находил маршрут
-- «Зеленовские озерки» ТОЛЬКО в секции «Совпали названием маршрута» —
-- у route_waypoints для него не было ни одной видимой строки, а
-- groupRoutesByDestination (lib/on-route/destination.ts) намеренно не
-- выдумывает Destination без реального places.id/lat/lng («настоящей цели
-- за ними нет»). Клик «На карте» дальше честно отвечал «У точек маршрута
-- нет координат» (openPreview в app/planning/_PlanningClient.tsx) — платформа
-- знала о существовании маршрута (title, geometry, distance_km), но не знала,
-- ГДЕ он заканчивается, и не могла предложить его целью.
--
-- Источник координат — владелец, напрямую, в сообщении 30.08:
-- 53.280367, 158.317736. Больше о месте (высота, рельеф, сезонность и т.д.)
-- никто не подтверждал — описание ниже это и говорит, без выдумки фактов,
-- которых нет (§4.0 CLAUDE.md).
--
-- link_kind = 'unknown' — не 'waypoint': по правилу миграции 874, связь,
-- заведённую вручную ПОЗЖЕ (не из улик 653-657/655-656), мы не вправе
-- объявить путевой точкой. Черта §12 продолжит судить эту связь как раньше;
-- на выбор цели (groupRoutesByDestination, /api/routes/search) link_kind не
-- влияет вовсе — там фильтруется только is_visible.
--
-- Идемпотентна: фиксированный id места + name-гард на INSERT, NOT EXISTS
-- на связь route_waypoints.

BEGIN;

INSERT INTO places
  (id, ark_id, name, description, lat, lng, location_type, category, is_visible)
SELECT
  'f31f3774-65d4-47b7-a03e-4e3d4a575100',
  'f31f3774-65d4-47b7-a03e-4e3d4a575100'::uuid,
  'Зеленовские озерки',
  'Озёра, к которым ведёт маршрут «Зеленовские озерки». Координаты — от '
  || 'владельца платформы (30.08.2026); подробности места (глубина, сезонность, '
  || 'подход) пока не подтверждены и здесь не указываются.',
  53.280367, 158.317736,
  'lake', 'lake',
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM places WHERE name ILIKE '%зеленовские озерки%'
);

-- Связь с маршрутом того же имени — единственная известная точка на нём
-- (position 0). Если такого маршрута нет или он уже слит/скрыт, ничего не
-- вставляется — DO-блок не нужен, оба условия проверяются в одном INSERT.
INSERT INTO route_waypoints (route_id, place_id, "position", link_kind, link_kind_at)
SELECT r.id, p.id, 0, 'unknown', now()
FROM kamchatka_routes r, places p
WHERE r.title ILIKE '%Зеленовские озерки%'
  AND r.is_visible = TRUE AND r.merged_into_id IS NULL
  AND p.id = 'f31f3774-65d4-47b7-a03e-4e3d4a575100'
  -- ::text с обеих сторон намеренно (миграция 874 шесть раз падала на
  -- `text = uuid` — здесь route_id/id совпадают по типу случайно, но
  -- сторож tests/unit/migration-id-type-domain.test.ts судит по имени
  -- колонки, не по факту, и предположение типа запрещено новым миграциям).
  AND NOT EXISTS (
    SELECT 1 FROM route_waypoints rw
    WHERE rw.route_id::text = r.id::text AND rw.place_id::text = p.id::text
  );

COMMIT;
