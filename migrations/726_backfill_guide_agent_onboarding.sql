-- Migration 726: бэкфилл onboarding_completed для действующих guide/agent
--
-- Гейт онбординга расширяется на кабинеты guide и agent (визарды + гварды).
-- Как и 724 (gear/stay), помечаем завершённым партнёра, у которого уже есть
-- контент, — чтобы действующие партнёры не попали в визард после деплоя.
-- Пустые кабинеты честно проходят онбординг — им он и адресован.
--
-- Сигналы «есть контент»:
--   guide  — аттестации (guide_certifications.guide_id = partners.id;
--            именно аттестованные гиды — действующие). guide_schedule НЕ
--            используем: в кодовой базе две конфликтующие DDL-версии
--            (guide_id → users vs → partners), FK неоднозначен.
--   agent  — клиенты или брони (агентские таблицы ключаются на user_id,
--            не на partners.id!).
--
-- Идемпотентна: safe to run multiple times.

BEGIN;

UPDATE partners p
SET onboarding_completed = true, updated_at = NOW()
WHERE p.category = 'guide'
  AND p.onboarding_completed = false
  AND EXISTS (SELECT 1 FROM guide_certifications gc WHERE gc.guide_id = p.id);

UPDATE partners p
SET onboarding_completed = true, updated_at = NOW()
WHERE p.category = 'agent'
  AND p.onboarding_completed = false
  AND (
    EXISTS (SELECT 1 FROM agent_clients ac WHERE ac.agent_id = p.user_id)
    OR EXISTS (SELECT 1 FROM agent_bookings ab WHERE ab.agent_id = p.user_id)
  );

COMMIT;
