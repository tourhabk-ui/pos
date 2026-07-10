-- Migration 732: отметка обогащения карточки маршрута из OCR-паспорта
--
-- route_passport_ocr (migration 730) хранит markdown паспорта. Обогащение
-- полей карточки (hazards/equipment/season/... — §10) идёт партиями через
-- /api/cron/enrich-passports. enriched_at помечает уже разобранные строки,
-- чтобы batched-прогон не перерабатывал их (селект по enriched_at IS NULL).
-- Идемпотентна.

BEGIN;

ALTER TABLE route_passport_ocr
  ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;

COMMIT;
