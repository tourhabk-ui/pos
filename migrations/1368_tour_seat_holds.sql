-- 1368: «Занять места» из чата оператора (план CRM в мессенджере, PR4;
-- решение владельца 02.11: держится, пока оператор сам не освободит).
--
-- Не бронь и не оплата: ручное удержание мест на дату под заявку.
-- Одна активная запись на (тур, дата, предмет) — повторное «Занять» не двоит.

BEGIN;

CREATE TABLE IF NOT EXISTS tour_seat_holds (
  id           BIGSERIAL PRIMARY KEY,
  operator_id  UUID NOT NULL,
  tour_id      BIGINT NOT NULL REFERENCES operator_tours(id) ON DELETE CASCADE,
  hold_date    DATE NOT NULL,
  seats        INTEGER NOT NULL CHECK (seats > 0 AND seats <= 500),
  subject_kind TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  created_by   UUID,
  via          TEXT NOT NULL CHECK (via IN ('max', 'telegram', 'site')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at  TIMESTAMPTZ,
  released_by  UUID
);

CREATE UNIQUE INDEX IF NOT EXISTS tour_seat_holds_active_uniq
  ON tour_seat_holds (tour_id, hold_date, subject_kind, subject_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS tour_seat_holds_day
  ON tour_seat_holds (tour_id, hold_date) WHERE released_at IS NULL;

COMMIT;

-- Rollback:
-- DROP TABLE IF EXISTS tour_seat_holds;
