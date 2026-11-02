-- 1370: «Стоп-продажи» из чата оператора (план CRM в мессенджере, PR5;
-- решение владельца 02.11: только оператор).
--
-- Журнал: кто, когда, какой тур и какие даты закрыл или снова открыл.
-- Сами даты закрываются в tour_availability (is_cancelled, причина
-- «Стоп-продажа оператора») — сайт и Кузьмич закрытую дату не предлагают.

BEGIN;

CREATE TABLE IF NOT EXISTS tour_stop_sales (
  id           BIGSERIAL PRIMARY KEY,
  operator_id  UUID NOT NULL,
  tour_id      BIGINT NOT NULL REFERENCES operator_tours(id) ON DELETE CASCADE,
  action       TEXT NOT NULL CHECK (action IN ('close', 'open')),
  date_from    DATE NOT NULL,
  date_to      DATE NOT NULL,
  dates        DATE[] NOT NULL,
  kept_booked  DATE[] NOT NULL DEFAULT '{}',
  created_by   UUID,
  via          TEXT NOT NULL CHECK (via IN ('max', 'telegram', 'site')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tour_stop_sales_tour ON tour_stop_sales (tour_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tour_stop_sales_operator ON tour_stop_sales (operator_id, created_at DESC);

COMMIT;

-- Rollback:
-- DROP TABLE IF EXISTS tour_stop_sales;
