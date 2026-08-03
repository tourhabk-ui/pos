-- Migration 803: убрать ДУБЛЬ тура сплава по Быстрой (создан миграцией 800)
--
-- Косяк 800: она искала тур по названию 'Однодневная экскурсия СПЛАВ ПО РЕКЕ
-- БЫСТРАЯ' и, не найдя (реальный тур на проде называется «Сплав по реке
-- Быстрая», id 27), ВСТАВИЛА второй тур — получился дубль в каталоге.
--
-- Гасим дубль с длинным названием (тот, что создала 800), но ТОЛЬКО если:
--   • у него нет ни одной брони (иначе осиротеют — разбирать вручную);
--   • существует ДРУГОЙ живой тур сплава по Быстрой (не удаляем единственный —
--     на чистом окружении длинное название и есть настоящий тур).
-- Настоящий тур (короткое название «Сплав по реке Быстрая») остаётся.
-- Мягкое удаление (deleted_at) — данные не теряем. Идемпотентна.

UPDATE operator_tours dup
   SET deleted_at   = NOW(),
       is_published = FALSE,
       is_active    = FALSE,
       updated_at   = NOW()
 WHERE dup.deleted_at IS NULL
   AND dup.title = 'Однодневная экскурсия СПЛАВ ПО РЕКЕ БЫСТРАЯ'
   AND NOT EXISTS (
     SELECT 1 FROM operator_bookings b WHERE b.operator_tour_id = dup.id
   )
   AND EXISTS (
     SELECT 1 FROM operator_tours real
      WHERE real.deleted_at IS NULL
        AND real.id <> dup.id
        AND real.title ILIKE '%быстр%'
        AND real.title ILIKE '%сплав%'
   );
