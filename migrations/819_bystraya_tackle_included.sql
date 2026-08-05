-- Migration 819: снасти входят в стоимость, а не сдаются в аренду
--
-- Замечание Катерины («Камчатка Рафтинг», 05.08): снасти входят в стоимость
-- бесплатно, никакой аренды за 500 рублей нет.
--
-- Почему миграция написана «по смыслу», а не по точному тексту. Строки
-- «аренда снастей 500» в репозитории НЕТ: 796 честно кладёт «Удочки и снасти
-- для рыбалки» в included. Но 796 — одна из трёх миграций, которые на проде
-- так и не применились, поэтому что именно лежит в полях живого тура, отсюда
-- не видно. Значит нельзя чинить сравнением с известной строкой — надо
-- привести поля к правильному состоянию из ЛЮБОГО текущего.
--
-- Отсюда форма: из not_included убираем всё, что говорит об аренде или прокате
-- снастей (в любой формулировке и с любой ценой), а в included добавляем
-- снасти, если их там ещё нет. Ни один посторонний пункт не затронут — в
-- отличие от переписывания массива целиком, которое стёрло бы то, чего я не
-- вижу.
--
-- Цена ошибки: турист платит на месте за то, что уже оплачено. Такие вещи
-- разрушают доверие к платформе быстрее, чем любой дизайн его строит.
--
-- Матч по содержанию, без INSERT. Идемпотентна: срабатывает, только пока есть
-- что убрать или что добавить.

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
   SET not_included = COALESCE((
         SELECT array_agg(x ORDER BY ord)
           FROM unnest(COALESCE(ot.not_included, ARRAY[]::text[])) WITH ORDINALITY AS t(x, ord)
          WHERE x !~* '(аренд|прокат)'
             OR x !~* '(снаст|удоч|спиннинг)'
       ), ARRAY[]::text[]),
       included = CASE
         WHEN NOT EXISTS (
           SELECT 1
             FROM unnest(COALESCE(ot.included, ARRAY[]::text[])) AS y
            WHERE y ILIKE '%снаст%' OR y ILIKE '%удочк%'
         )
         THEN COALESCE(ot.included, ARRAY[]::text[]) || 'Удочки и снасти для рыбалки'::text
         ELSE ot.included
       END,
       updated_at = NOW()
  FROM canonical c
 WHERE ot.id = c.id
   AND (
     -- есть что убрать из «не входит»
     EXISTS (
       SELECT 1
         FROM unnest(COALESCE(ot.not_included, ARRAY[]::text[])) AS x
        WHERE x ~* '(аренд|прокат)' AND x ~* '(снаст|удоч|спиннинг)'
     )
     -- либо снастей нет в «входит в стоимость»
     OR NOT EXISTS (
       SELECT 1
         FROM unnest(COALESCE(ot.included, ARRAY[]::text[])) AS y
        WHERE y ILIKE '%снаст%' OR y ILIKE '%удочк%'
     )
   );
