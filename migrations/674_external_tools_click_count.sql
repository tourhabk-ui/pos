ALTER TABLE external_tools ADD COLUMN IF NOT EXISTS click_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_external_tools_click_count ON external_tools (click_count DESC);
