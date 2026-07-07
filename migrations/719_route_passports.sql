-- Migration 719: официальные паспорта маршрутов (visitkamchatka.ru)
--
-- Портал публикует ~130 PDF-паспортов маршрутов, утверждённых Минтуризма
-- края, КГБУ «Вулканы Камчатки» и ФГБУ «Кроноцкий заповедник». Импорт
-- (scripts/import-route-passports.ts) привязывает паспорт к маршруту:
-- ссылка на первоисточник + ведомство + момент верификации.
--
-- Существующее поле pdf_url остаётся как есть (историческая ссылка из
-- ранних импортов); official_passport_url — подтверждённая скриптом
-- привязка с ведомством.
--
-- Идемпотентна: safe to run multiple times.

BEGIN;

ALTER TABLE kamchatka_routes
  ADD COLUMN IF NOT EXISTS official_passport_url TEXT,
  ADD COLUMN IF NOT EXISTS passport_agency       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS passport_verified_at  TIMESTAMPTZ;

COMMIT;
