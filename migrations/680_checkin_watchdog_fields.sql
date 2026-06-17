-- Migration 680: поля для check-in сторожа маршрутов
-- Добавляет контрольное время возврата, тип похода, последнюю GPS-позицию
-- и подтверждение «я в порядке» к таблице route_registrations

ALTER TABLE route_registrations
  ADD COLUMN IF NOT EXISTS expected_return_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trip_kind             VARCHAR(10) DEFAULT 'day'
    CHECK (trip_kind IN ('day', 'multi')),
  ADD COLUMN IF NOT EXISTS last_position_lat     DECIMAL(9,6),
  ADD COLUMN IF NOT EXISTS last_position_lng     DECIMAL(9,6),
  ADD COLUMN IF NOT EXISTS last_position_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS checkin_confirmed_at  TIMESTAMPTZ;

-- Индекс для почасового запроса сторожа: только активные с ожидаемым возвратом
CREATE INDEX IF NOT EXISTS idx_route_registrations_watchdog
  ON route_registrations(expected_return_at)
  WHERE completed_at IS NULL AND expected_return_at IS NOT NULL;
