-- Migration 683: Tourist self-registration check-in for missed return alerts
-- Tourist sets expected return time + emergency contact.
-- If not cancelled before deadline → watchdog sends Telegram alert to admin chat.

CREATE TABLE IF NOT EXISTS tourist_checkins (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tourist_name     TEXT         NOT NULL,
  route_name       TEXT         NOT NULL,
  return_deadline  TIMESTAMPTZ  NOT NULL,
  -- Emergency contact info (always shown in alert to admin)
  emergency_name   TEXT         NOT NULL,
  emergency_phone  TEXT,
  emergency_telegram TEXT,
  -- Optional last known position (set at creation, not live-tracked)
  last_lat         NUMERIC(10,7),
  last_lng         NUMERIC(10,7),
  -- State machine
  status           VARCHAR(20)  NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled', 'alerted', 'resolved')),
  cancel_token     TEXT         NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  alert_sent_at    TIMESTAMPTZ,
  alert_count      INTEGER      NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  cancelled_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_checkins_active_deadline
  ON tourist_checkins(return_deadline)
  WHERE status = 'active';
