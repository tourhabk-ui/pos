-- Migration 817: описание тура перестаёт быть третьей копией программы
--
-- Владелец на живой карточке 05.08: блок «О туре» повторяет сам себя, а под ним
-- ещё раз идёт вся программа дня — та же, что нарисована аккордеоном ниже.
--
-- Как это получилось. Миграция 793 (июль) положила в description весь текст
-- анонса оператора: суть тура, список «В программе», состав «В стоимость
-- входит». Тогда это было правильно — других полей просто не существовало.
-- Потом 796 завела included/not_included/what_to_bring, а 809 — program (JSONB,
-- аккордеон). Каждая честно наполнила своё поле и НИ ОДНА не убрала то, что
-- теперь дублировала. Итог: программа живёт в трёх местах, состав — в двух.
--
-- Хуже дубля — расхождение. В description остался старый оборот «Выезд из
-- Петропавловска-Камчатского (Паратунская зона отдыха)»: то самое противоречие
-- о месте сбора, которое 814 исправила ТОЛЬКО в program. Турист читает карточку
-- сверху вниз и получает две разные версии одного дня.
--
-- Ровно тот же класс, что имя оператора в partners и users: факт живёт в двух
-- местах, чинят одно.
--
-- Здесь ничего не сочиняется — только убирается лишнее. В описании остаётся
-- то, чего НЕТ ни в одном структурированном поле:
--   • характер тура (спокойный семейный, не спортивный рафтинг);
--   • скидки детям до 14 лет — этого факта нет больше нигде.
-- Программу, состав и снаряжение карточка берёт из program/included/
-- not_included/what_to_bring.
--
-- Матч по содержанию, без INSERT. Идемпотентна: срабатывает, только пока
-- описание содержит перечисления, переехавшие в свои поля.

WITH canonical AS (
  SELECT ot.id
    FROM operator_tours ot
   WHERE ot.deleted_at IS NULL
     AND ot.title ILIKE '%быстр%'
     AND (ot.title ILIKE '%сплав%' OR ot.activity_type IN ('rafting', 'boat_trip'))
   ORDER BY
     CASE WHEN ot.title = 'Сплав по реке Быстрая' THEN 0 ELSE 1 END,
     ot.created_at ASC
   LIMIT 1
)
UPDATE operator_tours ot
   SET description = 'Спокойный семейный маршрут — не спортивный рафтинг. Детям до 14 лет — скидки, размер уточняйте у оператора.',
       updated_at = NOW()
  FROM canonical c
 WHERE ot.id = c.id
   AND (ot.description LIKE '%В программе%' OR ot.description LIKE '%В стоимость входит%');

-- Та же фраза о характере тура стояла и в шаге программы — теперь она живёт
-- в описании, а шаг говорит только о самом сплаве.
WITH canonical AS (
  SELECT ot.id
    FROM operator_tours ot
   WHERE ot.deleted_at IS NULL
     AND ot.title ILIKE '%быстр%'
     AND (ot.title ILIKE '%сплав%' OR ot.activity_type IN ('rafting', 'boat_trip'))
   ORDER BY
     CASE WHEN ot.title = 'Сплав по реке Быстрая' THEN 0 ELSE 1 END,
     ot.created_at ASC
   LIMIT 1
)
UPDATE operator_tours ot
   SET program = jsonb_set(
         ot.program,
         '{3,text}',
         to_jsonb('Сплав с гидом. По пути рыбалка и шанс фотоохоты на бурого медведя.'::text)
       ),
       updated_at = NOW()
  FROM canonical c
 WHERE ot.id = c.id
   AND jsonb_typeof(ot.program) = 'array'
   AND jsonb_array_length(ot.program) > 3
   AND ot.program #>> '{3,title}' = 'Сплав с гидом и рыбалка'
   AND ot.program #>> '{3,text}' LIKE '%не спортивный рафтинг%';
