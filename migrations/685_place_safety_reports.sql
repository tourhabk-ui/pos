-- Migration 685: place_safety_reports
-- UGC safety conditions reported by tourists at the location.
-- No gamification. No ratings. Safety facts only.

CREATE TABLE IF NOT EXISTS place_safety_reports (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id     UUID        NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  user_id      UUID,                                  -- NULL = anonymous
  is_ok        BOOLEAN     NOT NULL DEFAULT TRUE,     -- true = all clear
  conditions   TEXT[]      NOT NULL DEFAULT '{}',     -- selected condition tags
  note         TEXT        CHECK (char_length(note) <= 300),
  reporter_lat DECIMAL(9,6),
  reporter_lng DECIMAL(9,6),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_psr_place_created
  ON place_safety_reports (place_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_psr_created
  ON place_safety_reports (created_at DESC);
