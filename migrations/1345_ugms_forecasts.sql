-- 1345: прогноз Камчатского УГМС по дням и районам (29.10).
--
--
-- Номер: писалась как 1343; 29.10 его и 1344 заняли параллельные ветки
-- (laguna_expedition_photos, tour_main_place_verified) — перенумерована
-- после слияния с main.
-- Владелец: «по погоде мне нужен самый точный прогноз», «есть же камчатский
-- гидромет». Официальный суточный прогноз ФГБУ «Камчатское УГМС» читается с
-- kammeteo.ru (prognoz/prognozy1.php — на сутки, prognozy2.php — на 2–3
-- сутки; проба 1015) и хранится дословно: день, район (город / южные районы /
-- северные районы), текст, заметки («На дорогах гололедица»). Читают
-- страница /weather и Кузьмич (lib/weather/ugms-forecast.ts); пишет
-- /api/cron/ugms-forecast. На день и район — одна запись на страницу-источник;
-- прочитанный заново текст обновляет запись, updated_at двигается только при
-- изменении текста.

BEGIN;

CREATE TABLE IF NOT EXISTS ugms_forecasts (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('day1', 'day23')),
  forecast_date DATE NOT NULL,
  zone          TEXT NOT NULL CHECK (zone IN ('city', 'south', 'north')),
  text          TEXT NOT NULL,
  notes         TEXT[] NOT NULL DEFAULT '{}',
  source_url    TEXT NOT NULL,
  text_hash     TEXT NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kind, forecast_date, zone)
);

CREATE INDEX IF NOT EXISTS idx_ugms_forecasts_date ON ugms_forecasts (forecast_date);

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS ugms_forecasts;
-- COMMIT;
