-- Migration 724: бэкфилл onboarding_completed для действующих партнёров
--
-- Проблема: онбординг-гварды gear/stay уводят в визард всех с
-- onboarding_completed = false, а миграция 052 добавила колонку
-- DEFAULT FALSE без бэкфилла. Без этого шага ВСЕ действующие партнёры
-- с товарами/объектами после деплоя попали бы в визард «первый товар».
--
-- Завершённым считаем партнёра, у которого уже есть контент:
-- gear — позиции инвентаря, stay — объекты размещения. Пустые кабинеты
-- честно проходят онбординг — им он и адресован.
--
-- Идемпотентна: safe to run multiple times.

BEGIN;

UPDATE partners p
SET onboarding_completed = true, updated_at = NOW()
WHERE p.category = 'gear'
  AND p.onboarding_completed = false
  AND EXISTS (SELECT 1 FROM gear_items gi WHERE gi.partner_id = p.id);

UPDATE partners p
SET onboarding_completed = true, updated_at = NOW()
WHERE p.category = 'stay'
  AND p.onboarding_completed = false
  AND EXISTS (SELECT 1 FROM accommodations a WHERE a.partner_id = p.id);

COMMIT;
