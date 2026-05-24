ALTER TABLE ai_route_images
  ADD COLUMN IF NOT EXISTS photo_verified    BOOLEAN DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ai_audit_reason   TEXT,
  ADD COLUMN IF NOT EXISTS ai_audit_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS manually_reviewed BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS ai_route_images_photo_verified_idx
  ON ai_route_images(photo_verified);
