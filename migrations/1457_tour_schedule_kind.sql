-- Migration 1457: как тур выезжает — по своим датам или в любой день сезона
-- Created: 2026-11-16
--
-- #3476, слово владельца 16.11 «Да, так»: тур без строк календаря
-- (tour_availability) показывался «Даты по запросу», и под одной подписью
-- жили два разных случая — оператор выезжает в любой день сезона, если
-- набирается группа, и оператор просто не опубликовал даты.
--
-- operator_tours.schedule_kind — слово оператора о своём туре:
--   departures — выезды только в даты его календаря;
--   any_day    — любой день между season_start и season_end; строка
--                календаря у такого тура — исключение (закрыть день,
--                ограничить места), а не единственная дата;
--   NULL       — не указано: как до этой миграции (третий исход, §4.0).
-- Ставит оператор (кнопкой — #3476 шаг 4); уже заведённым турам — миграцией
-- по его записанным словам, с источником (шаг 5). Эта миграция ничего не
-- проставляет: колонка пустая у всех.
--
-- Правило чтения — lib/tours/schedule-kind.ts.
-- Идемпотентно.

BEGIN;

ALTER TABLE operator_tours ADD COLUMN IF NOT EXISTS schedule_kind TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operator_tours_schedule_kind_check') THEN
    ALTER TABLE operator_tours ADD CONSTRAINT operator_tours_schedule_kind_check
      CHECK (schedule_kind IN ('departures', 'any_day'));
  END IF;
END $$;

COMMENT ON COLUMN operator_tours.schedule_kind IS
  'departures — только даты календаря; any_day — любой день сезона (календарь — исключения); NULL — не указано (#3476)';

COMMIT;
