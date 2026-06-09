-- Migration 676: Fix smart_notifications_log.user_id type
-- user_ai_memory.user_id is UUID (references users.id UUID).
-- The original column was INTEGER, causing every INSERT to fail.

ALTER TABLE smart_notifications_log
  DROP COLUMN IF EXISTS user_id;

ALTER TABLE smart_notifications_log
  ADD COLUMN user_id UUID NOT NULL DEFAULT gen_random_uuid();

-- The DEFAULT above is only for the ALTER ADD. We want it mandatory
-- without a default going forward, so we set no-default immediately.
ALTER TABLE smart_notifications_log
  ALTER COLUMN user_id DROP DEFAULT;

DROP INDEX IF EXISTS idx_smart_notify_user_time;

CREATE INDEX IF NOT EXISTS idx_smart_notify_user_time
  ON smart_notifications_log(user_id, created_at DESC);
