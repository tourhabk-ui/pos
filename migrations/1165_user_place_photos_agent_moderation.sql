-- Migration 1164: агент модерации снимков туристов
-- Created: 2026-10-04
--
-- Решение владельца 04.10: снимки, загруженные туристами на карточку места,
-- модерирует агент по расписанию (app/api/cron/user-photo-moderate), сам
-- одобряет и отклоняет; первые пять решений владелец проверяет. Колонки —
-- след каждого решения: что увидело зрение, что решил агент и почему, и
-- отпечаток кадра для поиска повторов (тот же dHash, что у ai_route_images,
-- миграция 1146). NULL везде — «агент не смотрел», а не «чисто» (§4.0).

BEGIN;

ALTER TABLE user_place_photos ADD COLUMN IF NOT EXISTS phash          TEXT;
ALTER TABLE user_place_photos ADD COLUMN IF NOT EXISTS vision_verdict JSONB;
ALTER TABLE user_place_photos ADD COLUMN IF NOT EXISTS agent_decision TEXT;
ALTER TABLE user_place_photos ADD COLUMN IF NOT EXISTS agent_reason   TEXT;
ALTER TABLE user_place_photos ADD COLUMN IF NOT EXISTS agent_at       TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'user_place_photos' AND constraint_name = 'user_place_photos_agent_decision_chk'
  ) THEN
    ALTER TABLE user_place_photos
      ADD CONSTRAINT user_place_photos_agent_decision_chk
      CHECK (agent_decision IS NULL OR agent_decision IN ('approved', 'rejected', 'human'));
  END IF;
END $$;

-- Очередь агента: ждущие и ещё не просмотренные.
CREATE INDEX IF NOT EXISTS idx_user_place_photos_agent_queue
  ON user_place_photos (created_at) WHERE status = 'pending' AND agent_at IS NULL;

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE user_place_photos DROP CONSTRAINT IF EXISTS user_place_photos_agent_decision_chk;
-- ALTER TABLE user_place_photos DROP COLUMN IF EXISTS phash, DROP COLUMN IF EXISTS vision_verdict,
--   DROP COLUMN IF EXISTS agent_decision, DROP COLUMN IF EXISTS agent_reason, DROP COLUMN IF EXISTS agent_at;
-- DROP INDEX IF EXISTS idx_user_place_photos_agent_queue;
-- COMMIT;
