-- Migration 721: тарифный календарь жилья (accommodation_availability)
--
-- Проблема: цены жилья существуют только как price_per_night_from/to у объекта
-- и price_per_night у номера. Публичный /api/accommodations/[id]/prices
-- ВЫДУМЫВАЛ динамику (базовая цена ×1.2 по пт/сб) — заменяется реальным
-- календарём тарифов по образцу tour_availability (migration 040).
--
-- Строка календаря: объект + опционально номер + дата. room_id IS NULL —
-- тариф уровня объекта (применяется, если для номера нет своей строки).
-- Уникальность с nullable room_id обычным UNIQUE не выразить (NULL != NULL),
-- поэтому два partial unique index — ON CONFLICT в коде указывает нужный.
--
-- Заодно фикс дрейфа схемы: create-роут (app/api/accommodations/create)
-- пишет cancellation_policy, которой в migration 716 не было.
--
-- Идемпотентна: safe to run multiple times.

BEGIN;

CREATE TABLE IF NOT EXISTS accommodation_availability (
  id               BIGSERIAL     PRIMARY KEY,
  accommodation_id UUID          NOT NULL REFERENCES accommodations(id) ON DELETE CASCADE,
  room_id          UUID          REFERENCES accommodation_rooms(id) ON DELETE CASCADE,
  date             DATE          NOT NULL,
  price_override   DECIMAL(10,2) CHECK (price_override >= 0),
  available_rooms  INTEGER       CHECK (available_rooms >= 0),
  is_blocked       BOOLEAN       NOT NULL DEFAULT FALSE,
  block_reason     TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ   DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_accommodation_availability_object_date
  ON accommodation_availability (accommodation_id, date)
  WHERE room_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_accommodation_availability_room_date
  ON accommodation_availability (accommodation_id, room_id, date)
  WHERE room_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_accommodation_availability_date
  ON accommodation_availability (date);

DROP TRIGGER IF EXISTS trg_accommodation_availability_updated_at ON accommodation_availability;
CREATE TRIGGER trg_accommodation_availability_updated_at
  BEFORE UPDATE ON accommodation_availability
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE accommodations ADD COLUMN IF NOT EXISTS cancellation_policy TEXT;

COMMIT;
