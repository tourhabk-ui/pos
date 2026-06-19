-- Migration 685: place_safety_reports
-- UGC safety reports from tourists at a location.
-- Triggered by proximity (geo-trigger), not rating/gamification.

CREATE TABLE IF NOT EXISTS place_safety_reports (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id     UUID        NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  user_id      UUID,                          -- NULL = anonymous
  is_ok        BOOLEAN     NOT NULL DEFAULT TRUE,
  conditions   TEXT[]      NOT NULL DEFAULT '{}',
  note         TEXT        CHECK (char_length(note) <= 300),
  reporter_lat DECIMAL(9,6),
  reporter_lng DECIMAL(9,6),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_place_safety_reports_place
  ON place_safety_reports (place_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_place_safety_reports_recent
  ON place_safety_reports (created_at DESC)
  WHERE created_at > NOW() - INTERVAL '7 days';
