-- 1375: группа у всех 10 туров «Камчатской рыбалки» — от 5 до 14 человек.
-- Слово владельца 03.11.2026: «минимум 5 чел, но до 14». Минимум 5 совпадает
-- с fishingkam.ru («Минимальная группа — 5 человек»). Цены не трогаем.
-- Якорь — id + оператор (как 837/914/916/1374); идемпотентно.
UPDATE operator_tours ot
   SET min_participants = 5,
       max_participants = 14,
       updated_at = NOW()
 WHERE ot.id IN (4, 5, 6, 7, 9, 10, 11, 36, 37, 38)
   AND ot.deleted_at IS NULL
   AND (ot.min_participants IS DISTINCT FROM 5 OR ot.max_participants IS DISTINCT FROM 14)
   AND ot.operator_id = (SELECT id FROM partners WHERE name ILIKE '%камчатская рыбалка%' LIMIT 1);
