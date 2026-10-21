-- 1305: последний удачный прогноз Open-Meteo по точке — переживает перезапуск.
--
-- 21.10 вечером Open-Meteo с сервера не отвечал (таймауты), а прежний прогноз
-- лежал только в памяти процесса и пропал после трёх выкатов подряд: /weather,
-- блок погоды на «Обстановке» и Кузьмич остались пустыми. Здесь хранится
-- только последний удачный ответ по ключу точки (lat,lng до сотых, горизонт).
-- Отдаётся с отметкой «прогноз от …», не старше суток; старше — уборка.

CREATE TABLE IF NOT EXISTS weather_forecast_last_good (
  cache_key  VARCHAR(64) PRIMARY KEY,
  result     JSONB       NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS weather_forecast_last_good_fetched_at_idx
  ON weather_forecast_last_good (fetched_at);

COMMENT ON TABLE weather_forecast_last_good IS
  'Последний удачный прогноз Open-Meteo по точке (ключ lat,lng,horizon): запас на отказ источника после перезапуска, не старше суток (lib/weather/last-good-store)';
