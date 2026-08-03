-- Migration 801: вывести туры камчатской рыбалки в витрину «по новым правилам»
--
-- В базе есть туры рыбалки (fishingkam, ~11 шт; фото/состав добавляла 085), но
-- многие не опубликованы и/или без корректной категории «Рыбалка» — значит в
-- каталоге туров и на главной их не видно. Обрабатываем как сплав: публикуем и
-- проставляем activity_type='fishing'.
--
-- Матчим по СОДЕРЖАНИЮ (title/description содержит «рыбалк»/«рыбол»), а НЕ по
-- id: id на проде могут отличаться, а контент-признак надёжен и не заденет
-- чужие туры. Осознанно удалённые (deleted_at) НЕ воскрешаем. Логистику/точку
-- сбора не выдумываем (§8) — если оператор пришлёт, добавим отдельно, как у
-- сплава. Идемпотентна.

UPDATE operator_tours ot
   SET is_published  = TRUE,
       is_active     = TRUE,
       activity_type = 'fishing',
       updated_at    = NOW()
 WHERE ot.deleted_at IS NULL
   AND (
        ot.title ILIKE '%рыбалк%' OR ot.title ILIKE '%рыбол%'
     OR ot.short_description ILIKE '%рыбалк%'
     OR ot.description ILIKE '%рыбалк%'
     OR ot.activity_type = 'fishing'
   )
   AND (
        ot.is_published IS DISTINCT FROM TRUE
     OR ot.is_active IS DISTINCT FROM TRUE
     OR ot.activity_type IS DISTINCT FROM 'fishing'
   );
