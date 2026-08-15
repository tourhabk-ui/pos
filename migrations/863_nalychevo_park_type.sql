-- 863_nalychevo_park_type.sql
--
-- Природный парк «Налычево» числился типом hot_spring и потому стоял в
-- фильтре «Источники» на карте — с него и начался разбор 14.08. Парк — не
-- источник: источники в нём есть («Налычевские термальные источники» — своя
-- запись с своими координатами), а сам парк — территория. Тип — 'other', как
-- у записи-дубля «Природный парк Налычево», слитой в эту (проба 41).
--
-- Идемпотентна: правит только пока тип hot_spring.

UPDATE places SET location_type = 'other', updated_at = NOW()
 WHERE name = 'Природный парк «Налычево»'
   AND location_type = 'hot_spring';

INSERT INTO _migrations (name)
VALUES ('863_nalychevo_park_type.sql')
ON CONFLICT (name) DO NOTHING;
