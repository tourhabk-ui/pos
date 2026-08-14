-- Migration 857: бухты, реки, скалы и мысы — каждому своё имя типа
-- Created: 2026-08-14
--
-- Шестая серия чистки типов (после 851, 852, 854, 855, 856). Срезы проб 91-92:
--
-- В типе bay (11 записей):
--   · две видовки — смотровые, не бухты (тот же разряд, что 854)
--   · два лежбища морских млекопитающих на Командорских — не бухты (other);
--     это РАЗНЫЕ лежбища в 15 км, не дубли — решение проб 87-88
--   · «Скалы Три Брата» — скалы в типе бухты (rock); запись скрыта и есть
--     видимый тёзка в rock — свод в одну запись решается отдельной пробой
--     после эталонных координат, здесь только честный тип
--
-- В типе river (13):
--   · «Водопады каньона Студёный» — водопады (waterfall); «Каньон реки
--     Студеной» в 156 м — сам каньон (valley): это разные объекты, не дубли
--   · четыре каньона и цирк — valley, не river (каньон — форма рельефа,
--     а не водоток; у трёх из них координаты противоречат описанию — см.
--     флаги в отчёте, здесь координаты не трогаются)
--   · «Зимнее сап путешествие по реке Паратунка» — тур, не место (other,
--     как названия туров в 851)
--
-- В типе cape (проба 91): «Видовка на мысе Толстый» — смотровая (viewpoint).
--
-- Переименования (псевдоним раньше смены имени, порядок 851):
--   · «Смотрова площадка  на Тихий океан» — опечатка и двойной пробел
--   · «каньон Опасный» — имя со строчной
--
-- Правила: прицел по id И текущему типу; видимость не трогается; ничего не
-- удаляется и не сливается.

-- Бухты
UPDATE places SET location_type = 'viewpoint'
 WHERE id = 'a2bb67b4-3738-41e4-bc6a-a7fa81ccf81b' AND location_type = 'bay';

UPDATE places SET location_type = 'viewpoint'
 WHERE id = '42652df8-887c-443c-9ee2-af67a13e2be4' AND location_type = 'bay';

UPDATE places SET location_type = 'other'
 WHERE id = 'd5e1e9c0-175e-4b24-adb7-3adae4905979' AND location_type = 'bay';

UPDATE places SET location_type = 'other'
 WHERE id = '27c04946-ede8-40e6-88ce-af25cfe1a462' AND location_type = 'bay';

UPDATE places SET location_type = 'rock'
 WHERE id = 'fd3feffa-0e07-4a29-b4c8-216666dfe1e8' AND location_type = 'bay';

-- Реки
UPDATE places SET location_type = 'waterfall'
 WHERE id = 'b7ab4f91-45c6-4978-8f95-ba5f31751b15' AND location_type = 'river';

UPDATE places SET location_type = 'valley'
 WHERE id = '9c0a0654-affa-4887-bf5d-8fa4665911fe' AND location_type = 'river';

UPDATE places SET location_type = 'valley'
 WHERE id = '4c5767cf-f0ac-4efc-80d5-92e972ad6281' AND location_type = 'river';

UPDATE places SET location_type = 'valley'
 WHERE id = '15941908-e492-421a-89b4-766e8b00991c' AND location_type = 'river';

UPDATE places SET location_type = 'valley'
 WHERE id = 'abf90315-7a15-4fda-bb08-632b0f5e744b' AND location_type = 'river';

UPDATE places SET location_type = 'valley'
 WHERE id = 'c03b364f-55c3-4944-8505-3e86058999fa' AND location_type = 'river';

UPDATE places SET location_type = 'other'
 WHERE id = '92c22642-2a25-4efd-991e-c75a7107caec' AND location_type = 'river';

-- Мысы
UPDATE places SET location_type = 'viewpoint'
 WHERE id = '3d0bfbf3-f43a-4fe5-a0ed-980aea62bbeb' AND location_type = 'cape';

-- Переименования: сначала псевдоним, потом смена, гейт по старому имени
INSERT INTO place_aliases (place_id, alias, source_name)
SELECT id, name, source_name
  FROM places
 WHERE id = '42652df8-887c-443c-9ee2-af67a13e2be4'
   AND name = 'Смотрова площадка  на Тихий океан'
ON CONFLICT DO NOTHING;

UPDATE places SET name = 'Смотровая площадка на Тихий океан'
 WHERE id = '42652df8-887c-443c-9ee2-af67a13e2be4'
   AND name = 'Смотрова площадка  на Тихий океан';

INSERT INTO place_aliases (place_id, alias, source_name)
SELECT id, name, source_name
  FROM places
 WHERE id = '15941908-e492-421a-89b4-766e8b00991c'
   AND name = 'каньон Опасный'
ON CONFLICT DO NOTHING;

UPDATE places SET name = 'Каньон Опасный'
 WHERE id = '15941908-e492-421a-89b4-766e8b00991c'
   AND name = 'каньон Опасный';
