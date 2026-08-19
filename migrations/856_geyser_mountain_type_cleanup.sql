-- Migration 856: тип «гейзер» — только гейзерное; Долина гейзеров снова видна
-- Created: 2026-08-14
--
-- Пятая серия чистки типов (после 851 вулканы, 852 источники, 854 смотровые,
-- 855 озёра). Срез гейзеров (проба 90, 11 записей) показал: настоящих
-- гейзерных объектов в типе три, остальное — нарзаны, парогидротермальные
-- источники, фумарола, долина, мыс и кальдера. В горах — два трека-маршрута
-- (маршрутам место в kamchatka_routes, в places они получают тип other, как
-- названия туров в 851).
--
-- Главная находка серьёзнее типов: «Долина гейзеров» — визитная карточка
-- Камчатки — стоит is_visible = false при верных координатах (54.437/160.140,
-- в 75 метрах от видимого «Гейзера Красного»). Видимой записи о долине в
-- каталоге нет вовсе. Возвращаем видимость.
--
-- «ТРОПА МЕДВЕДЯ (ДОЛИНА СМЕРТИ)» переименовывается в «Долина Смерти»:
-- капс — не имя, а крик, и порядок слов задом наперёд. Старое имя уходит в
-- псевдонимы (как «Вулкан Ходутка — затерянный мир» в 851). Координаты записи
-- под подозрением (52.53/158.19 — район Вилючинского, а Долина Смерти лежит у
-- Кихпиныча) — координаты здесь НЕ трогаем, пока нет проверенного эталона.
--
-- Правила: прицел по id И текущему типу (идемпотентно); ничего не удаляется
-- и не сливается.

-- Гейзерное, оказавшееся источниками
UPDATE places SET location_type = 'hot_spring'
 WHERE id = '14999081-db57-43d3-8aad-f6c8361b69ac' AND location_type = 'geyser';

UPDATE places SET location_type = 'hot_spring'
 WHERE id = 'e7cc9f9d-479e-432f-8d1c-adcf6b62a1d8' AND location_type = 'geyser';

UPDATE places SET location_type = 'hot_spring'
 WHERE id = '5fe02f54-d018-4125-a0ec-e5fc458ad493' AND location_type = 'geyser';

UPDATE places SET location_type = 'hot_spring'
 WHERE id = '05112df7-54f9-4280-bcd2-1bfe4929dfc0' AND location_type = 'geyser';

-- Долины
UPDATE places SET location_type = 'valley'
 WHERE id = '4732f58e-63e5-4ec1-902e-f0f531391193' AND location_type = 'geyser';

UPDATE places SET location_type = 'valley'
 WHERE id = 'e552c8a2-52bd-4f7d-ad37-33b1a28460ab' AND location_type = 'geyser';

-- Мыс и кальдера
UPDATE places SET location_type = 'cape'
 WHERE id = '13b38bca-5663-43e9-8719-f7a822831100' AND location_type = 'geyser';

UPDATE places SET location_type = 'volcano'
 WHERE id = 'a6330106-13d5-40f0-9c77-d252daf5b95f' AND location_type = 'geyser';

-- Треки-маршруты в типе «гора»
UPDATE places SET location_type = 'other'
 WHERE id = '7846d641-ed72-42b9-846c-a87454d97b8f' AND location_type = 'mountain';

UPDATE places SET location_type = 'other'
 WHERE id = '790b3f98-b561-4818-80eb-8da0930d157d' AND location_type = 'mountain';

-- Переименование: старое имя сначала в псевдонимы, потом смена (порядок 851)
INSERT INTO place_aliases (place_id, alias, source_name)
SELECT id, name, source_name
  FROM places
 WHERE id = 'e552c8a2-52bd-4f7d-ad37-33b1a28460ab'
   AND name = 'ТРОПА МЕДВЕДЯ (ДОЛИНА СМЕРТИ)'
ON CONFLICT DO NOTHING;

UPDATE places SET name = 'Долина Смерти'
 WHERE id = 'e552c8a2-52bd-4f7d-ad37-33b1a28460ab'
   AND name = 'ТРОПА МЕДВЕДЯ (ДОЛИНА СМЕРТИ)';

-- Долина гейзеров: возврат видимости
UPDATE places SET is_visible = true
 WHERE id = '796c18b3-e199-4ac6-bbd6-de50d560ff40'
   AND name = 'Долина гейзеров'
   AND is_visible = false;
