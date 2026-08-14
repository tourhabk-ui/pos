-- Migration 854: смотровые называются смотровыми, водопад — водопадом
-- Created: 2026-08-14
--
-- Третья серия чистки типов (после 851 вулканы, 852 источники), по тем же
-- правилам: прицел по id И текущему типу, видимость не трогается, типы
-- только со словарной подписью.
--
-- Находки проб 87-88: «Вид на…» и «Видовка на…» лежали в типах mountain и
-- lake — смотровая на объект не есть сам объект, и в срезе гор она занимала
-- место ближайшего соседа настоящей горы. «Дикие озерки» — термальные ванны
-- в долине Паратунки (по собственному описанию), лежали в other.
--
-- Плюс одно переименование: видимая запись «смотровая» (с маленькой буквы,
-- без адреса) после слияния со скрытым дублем получает его говорящее имя.
-- Гейт по старому имени — идемпотентно.

BEGIN;

UPDATE places SET location_type = 'waterfall'
 WHERE id = '08316410-e234-4993-a378-996a9d1d823a' AND location_type = 'mountain'; -- Водопад, горный массив Вачкажец

UPDATE places SET location_type = 'viewpoint'
 WHERE id IN (
   'c1416d38-4680-4fad-8831-fff5a46fa377',  -- Вид на сопку Острая
   'c5e2c48a-c6d1-4f53-9cb7-eea1b0b0de2a',  -- Видовка на сопке Острая
   'd0ea1f87-c7b5-45a7-b6d7-999d4e5462e3'   -- Видовка на горе Верблюд
 ) AND location_type = 'mountain';

UPDATE places SET location_type = 'viewpoint'
 WHERE id = '88e23147-13e4-4bed-bae6-6dbcaf277cf9' AND location_type = 'lake'; -- Вид на озеро Икар

UPDATE places SET location_type = 'hot_spring'
 WHERE id = '36214e49-de02-4d1b-8f71-1926a1b319fa' AND location_type = 'other'; -- Дикие озерки — термы Паратунки

UPDATE places SET name = 'Смотровая на обрыве над Авачинской бухтой'
 WHERE id = '60b06659-f636-43b7-8b18-0601d8744739' AND name = 'смотровая';

COMMIT;

-- Rollback:
-- BEGIN;
-- UPDATE places SET location_type = 'mountain' WHERE id IN (
--   '08316410-e234-4993-a378-996a9d1d823a','c1416d38-4680-4fad-8831-fff5a46fa377',
--   'c5e2c48a-c6d1-4f53-9cb7-eea1b0b0de2a','d0ea1f87-c7b5-45a7-b6d7-999d4e5462e3');
-- UPDATE places SET location_type = 'lake' WHERE id = '88e23147-13e4-4bed-bae6-6dbcaf277cf9';
-- UPDATE places SET location_type = 'other' WHERE id = '36214e49-de02-4d1b-8f71-1926a1b319fa';
-- UPDATE places SET name = 'смотровая' WHERE id = '60b06659-f636-43b7-8b18-0601d8744739';
-- COMMIT;
