-- Migration 818: правки оператора — формулировка про медведя и сложность
--
-- Замечания Катерины («Камчатка Рафтинг», 05.08):
--   1. вместо «фотоохота на бурого медведя» — «возможность увидеть бурого
--      медведя в естественной среде»;
--   2. сложность — лёгкая, а не средняя.
--
-- Это правки ПРОДАВЦА о собственном продукте, то есть источник истины. Первая
-- не косметическая: «фотоохота» обещает охоту за кадром и подталкивает
-- подходить ближе; формулировка оператора описывает встречу, которая может
-- случиться, и ничего не обещает. Для платформы, чья первая цель —
-- безопасность туриста, это разница по существу.
--
-- Вторая меняет то, что турист читает в полосе фактов и в фильтре каталога.
-- «Средняя» стояла у нас с самого заведения тура и никем не подтверждалась;
-- оператор говорит «лёгкая» — берём его слово. Значение 'easy' есть в словаре
-- (lib/tours/labels.ts: «Подходит новичкам» / «Лёгкий»), новых заводить не надо.
--
-- Формулировка живёт в двух полях (short_description и шаг программы) — правим
-- оба разом. Урок трёх последних суток: факт в двух местах чинят в одном.
--
-- Матч по содержанию, без INSERT. Идемпотентна.

-- ── 1. Короткое описание ──────────────────────────────────────────────────────
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
   SET short_description = replace(
         ot.short_description,
         'фотоохотой на бурого медведя',
         'возможностью увидеть бурого медведя в естественной среде'
       ),
       updated_at = NOW()
  FROM canonical c
 WHERE ot.id = c.id
   AND ot.short_description LIKE '%фотоохот%';

-- ── 2. Шаг программы ──────────────────────────────────────────────────────────
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
         to_jsonb(
           replace(
             replace(ot.program #>> '{3,text}', 'шанс фотоохоты на бурого медведя', 'возможность увидеть бурого медведя в естественной среде'),
             'фотоохоты на бурого медведя', 'возможность увидеть бурого медведя в естественной среде'
           )
         )
       ),
       updated_at = NOW()
  FROM canonical c
 WHERE ot.id = c.id
   AND jsonb_typeof(ot.program) = 'array'
   AND jsonb_array_length(ot.program) > 3
   AND ot.program #>> '{3,title}' = 'Сплав с гидом и рыбалка'
   AND ot.program #>> '{3,text}' LIKE '%фотоохот%';

-- ── 3. Сложность ──────────────────────────────────────────────────────────────
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
   SET difficulty = 'easy',
       updated_at = NOW()
  FROM canonical c
 WHERE ot.id = c.id
   AND ot.difficulty IS DISTINCT FROM 'easy';
