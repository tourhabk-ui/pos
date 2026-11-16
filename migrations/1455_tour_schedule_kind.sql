-- Migration 1455: как тур выезжает — по датам календаря или в любой день сезона
-- Created: 2026-11-16
--
-- #3476, шаг 1. Слово владельца 16.11 «Да, так». Тур без строк календаря
-- (tour_availability) показывался «Даты по запросу», и под этой подписью
-- смешивались два разных случая:
--   - оператор выезжает в любой день сезона, если набирается группа
--     (гид: «ежедневно с 15 июля по 15 октября»);
--   - оператор просто не опубликовал даты.
--
-- operator_tours.schedule_kind:
--   'departures' — только даты календаря;
--   'any_day'    — любой день между season_start и season_end; строка
--                  календаря у такого тура — исключение (закрыть день или
--                  ограничить места);
--   NULL         — не указано: как сейчас, «Даты по запросу» (§4.0).
--
-- Умолчания нет и заполнения здесь нет: признак ставит оператор (кнопка —
-- шаг 4) или миграция по его записанным словам с источником (шаг 5). Правило
-- чтения одно — lib/tours/schedule-kind.ts; any_day без записанного сезона
-- читается как «не указано».
--
-- Идемпотентно: ADD COLUMN IF NOT EXISTS, CHECK — DROP IF EXISTS и заново.

BEGIN;

ALTER TABLE operator_tours ADD COLUMN IF NOT EXISTS schedule_kind TEXT;

ALTER TABLE operator_tours DROP CONSTRAINT IF EXISTS operator_tours_schedule_kind_check;
ALTER TABLE operator_tours ADD CONSTRAINT operator_tours_schedule_kind_check
  CHECK (schedule_kind IS NULL OR schedule_kind IN ('departures', 'any_day'));

COMMENT ON COLUMN operator_tours.schedule_kind IS
  'Как тур выезжает: departures — только даты календаря; any_day — любой день сезона (season_start..season_end), строка календаря — исключение; NULL — не указано (#3476, 16.11).';

COMMIT;
