-- 1376: вместимость дат «Камчатской рыбалки» — 14 мест на дату.
-- Слово владельца 03.11.2026 («делай»): группа до 14 (1375), календарь
-- держал 10 мест на дату. Только будущие даты (по Камчатке), только
-- ПОДНЯТЬ: available_slots — вместимость даты, занятость (брони, «Занять
-- места») считается отдельно и не трогается — свободно = 14 − занято.
-- Якорь — оператор + id туров (как 1374/1375); идемпотентно.
UPDATE tour_availability ta
   SET available_slots = 14,
       updated_at = NOW()
  FROM operator_tours ot
 WHERE ta.operator_tour_id::text = ot.id::text
   AND ot.id IN (4, 5, 6, 7, 9, 10, 11, 36, 37, 38)
   AND ot.operator_id = (SELECT id FROM partners WHERE name ILIKE '%камчатская рыбалка%' LIMIT 1)
   AND ta.date >= (NOW() AT TIME ZONE 'Asia/Kamchatka')::date
   AND ta.deleted_at IS NULL
   AND COALESCE(ta.is_cancelled, FALSE) = FALSE
   AND ta.available_slots < 14;
