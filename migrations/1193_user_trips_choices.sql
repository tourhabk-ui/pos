-- Migration 1193: выбранные жильё и трансфер в сохранённой поездке
-- Created: 2026-10-09
--
-- #2304, шаг 3б. В /planner жильё на стоянку и поездку перевозчика можно
-- взять в план (шаг 3): смета ставит их своей ценой вместо ориентира, заявка
-- уходит с ними. Сохранённая поездка выбор не хранила — после сохранения
-- страница «Моих поездок» снова считала ночь ориентиром, а заявка оттуда
-- уходила без жилья и трансфера.
--
-- Форма значения — lib/trips/trip-schema (TripChoicesSchema), снимок на день
-- сохранения:
--   {"stays": [{"zone": "avachinsky", "checkIn": "2030-08-03", "checkOut": "2030-08-05",
--               "nights": 2, "accommodationId": "…", "name": "…",
--               "price": {"kind": "priced", "total": 20000, "rooms": 1, …} | {"kind": "no_fit", …} | null}],
--    "transfers": [{"tripId": "…", "date": "2030-08-03", "from": "…", "to": "…",
--                   "seats": 2, "pricePerSeat": 1500 | null, "carrier": "…"}]}
-- NULL — поездка сохранена до этой миграции или без выбора.
--
-- Публичная страница поездки (/trip/<token>) колонку не читает.

BEGIN;

ALTER TABLE user_trips ADD COLUMN IF NOT EXISTS choices JSONB;

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE user_trips DROP COLUMN IF EXISTS choices;
-- COMMIT;
