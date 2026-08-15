-- 865_fix_place_types_batch5.sql
--
-- Партия 5, хвост: три записи, у которых тип спорит с именем и географией.
-- Найдены санитарной проверкой «имя против типа» по снимку прода 15.08.
--
-- 1. «Царь-бомба» числилась ГЕЙЗЕРОМ. Точка — район Толбачика (55.68,
--    160.25), где гейзеров не существует в принципе; «Царь-бомба» — это
--    знаменитая гигантская вулканическая бомба БТТИ. Тип rock — как у
--    прочих камней-достопримечательностей.
-- 2. «Скалы Халактырские» числились ПЛЯЖЕМ. Скалы — rock, как их сосед
--    «Скалы Три Брата»; на карте фильтр «Пляжи» показывал скалы.
-- 3. «Музей партунского поселения» числился other — на витрине выпадал из
--    фильтра «Музеи». Тип museum. Имя с вероятной опечаткой («партунского»
--    → паратунского?) НЕ правим: канонического названия в источниках не
--    нашлось, а угаданное имя хуже опечатки.
--
-- Идемпотентна: правит только пока стоит неверный тип.

UPDATE places SET location_type = 'rock', updated_at = NOW()
 WHERE name = 'Царь-бомба' AND location_type = 'geyser'
   AND merged_into_id IS NULL;

UPDATE places SET location_type = 'rock', updated_at = NOW()
 WHERE name = 'Скалы Халактырские' AND location_type = 'beach'
   AND merged_into_id IS NULL;

UPDATE places SET location_type = 'museum', updated_at = NOW()
 WHERE name = 'Музей партунского поселения' AND location_type = 'other'
   AND merged_into_id IS NULL;

INSERT INTO _migrations (name)
VALUES ('865_fix_place_types_batch5.sql')
ON CONFLICT (name) DO NOTHING;
