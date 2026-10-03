-- Migration 1153: «Гора Замок» — точка пути своего маршрута, а не «рядом»
-- Created: 2026-10-03
--
-- Скрин владельца 03.10: на карточке маршрута «Гора Замок» блок «Рядом с
-- маршрутом: Гора Замок» — место числилось «рядом» с маршрутом, который
-- к нему и ведёт. Из-за этого у маршрута ноль точек пути: черта судила
-- «линию не с чем сверить» (orientation_only), а карточка не показывала
-- кнопку «Начать навигацию».
--
-- Улика — та же, по которой 874 размечала путь: «место, чьё имя носит
-- маршрут, к маршруту относится — это точка пути» (пары 653). Имя маршрута
-- и имя места совпадают дословно. Расстояние до линии уликой НЕ служит
-- (§4.1), но для сведения: после правки координаты места 03.10 по OSM
-- (сверка run 11) место лежит в 17 м от последней вершины трека.
--
-- Одна пара, прицел по обоим id и по текущему роду: если связь уже
-- переразмечена — no-op. Позиция не трогается.

BEGIN;

UPDATE route_waypoints rw
   SET link_kind = 'waypoint', link_kind_at = NOW()
  FROM kamchatka_routes kr, places p
 WHERE kr.id::text = rw.route_id::text
   AND p.id::text = rw.place_id::text
   AND '66061e18-77ba-433f-b812-81e138266b2e' IN (kr.id::text, kr.ark_id::text)
   AND p.id::text = 'da81b46f-29dc-42e8-8137-ed2107347a68'
   AND kr.title = 'Гора Замок'
   AND p.name = 'Гора Замок'
   AND rw.link_kind = 'nearby';

COMMIT;

-- Rollback:
-- BEGIN;
-- UPDATE route_waypoints rw SET link_kind = 'nearby', link_kind_at = NOW()
--   FROM kamchatka_routes kr
--  WHERE kr.id::text = rw.route_id::text
--    AND '66061e18-77ba-433f-b812-81e138266b2e' IN (kr.id::text, kr.ark_id::text)
--    AND rw.place_id::text = 'da81b46f-29dc-42e8-8137-ed2107347a68';
-- COMMIT;
