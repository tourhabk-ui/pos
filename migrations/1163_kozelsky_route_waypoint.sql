-- Migration 1163: «Козельский» — точка пути своего маршрута, а не «рядом»
-- Created: 2026-10-04
--
-- Скрин владельца 04.10: карточка маршрута «Вулкан Козельский» открывается
-- заглушкой, хотя у места «Козельский» три снимка. Маршрут берёт кадры
-- точек ПУТИ (lib/routes/waypoint-photos), а место числилось «рядом» с
-- маршрутом, который к нему и ведёт (проба 697: linkKind nearby у всех трёх
-- точек — Козельский, Сейсмостанция, Каменный лес княженика).
--
-- Улика та же, что в 1153 («Гора Замок») и в разметке 874: место, чьё имя
-- носит маршрут, к маршруту относится — это точка пути. Имя маршрута —
-- «Вулкан Козельский», место — вулкан «Козельский». Расстояние уликой не
-- служит (§4.1). Сейсмостанция и Каменный лес не трогаются: их имён маршрут
-- не носит, и выводить их род из близости запрещено.
--
-- Одна пара, прицел по обоим id, именам и текущему роду: переразмечено —
-- no-op. Позиция не трогается.

BEGIN;

UPDATE route_waypoints rw
   SET link_kind = 'waypoint', link_kind_at = NOW()
  FROM kamchatka_routes kr, places p
 WHERE kr.id::text = rw.route_id::text
   AND p.id::text = rw.place_id::text
   AND 'a5161175-4d8b-4711-925a-de5ec03fa041' IN (kr.id::text, kr.ark_id::text)
   AND '7190e0a4-52f1-47fb-ba17-0fcb493d99df' IN (p.id::text, p.ark_id::text)
   AND kr.title = 'Вулкан Козельский'
   AND p.name = 'Козельский'
   AND rw.link_kind = 'nearby';

COMMIT;

-- Rollback:
-- BEGIN;
-- UPDATE route_waypoints rw SET link_kind = 'nearby', link_kind_at = NOW()
--   FROM kamchatka_routes kr, places p
--  WHERE kr.id::text = rw.route_id::text AND p.id::text = rw.place_id::text
--    AND 'a5161175-4d8b-4711-925a-de5ec03fa041' IN (kr.id::text, kr.ark_id::text)
--    AND '7190e0a4-52f1-47fb-ba17-0fcb493d99df' IN (p.id::text, p.ark_id::text);
-- COMMIT;
