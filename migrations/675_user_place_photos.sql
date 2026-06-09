-- 675: User-contributed photos for places
-- Tourists submit photos with caption; admin approves before display.

CREATE TABLE IF NOT EXISTS user_place_photos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id    UUID NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  url         TEXT NOT NULL,
  caption     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_user_place_photos_place ON user_place_photos(place_id) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_user_place_photos_user ON user_place_photos(user_id);
CREATE INDEX IF NOT EXISTS idx_user_place_photos_pending ON user_place_photos(status) WHERE status = 'pending';

INSERT INTO _migrations (name) VALUES ('675_user_place_photos.sql') ON CONFLICT (name) DO NOTHING;
