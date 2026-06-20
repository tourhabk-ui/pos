-- Migration 690: Enrich operator_tours for scraped operator data
-- Adds fields needed for honest price comparison (price_unit is critical)

ALTER TABLE operator_tours ADD COLUMN IF NOT EXISTS price_unit VARCHAR(20) DEFAULT 'unknown';
ALTER TABLE operator_tours ADD COLUMN IF NOT EXISTS group_size_max INT;
ALTER TABLE operator_tours ADD COLUMN IF NOT EXISTS price_note TEXT;
ALTER TABLE operator_tours ADD COLUMN IF NOT EXISTS includes TEXT;
ALTER TABLE operator_tours ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE operator_tours ADD COLUMN IF NOT EXISTS parsed_at TIMESTAMPTZ;
ALTER TABLE operator_tours ADD COLUMN IF NOT EXISTS is_stale BOOLEAN DEFAULT FALSE;

-- Allow base_price to be null for scraped tours where price is unknown
ALTER TABLE operator_tours ALTER COLUMN base_price DROP NOT NULL;
ALTER TABLE operator_tours ALTER COLUMN base_price SET DEFAULT NULL;

COMMENT ON COLUMN operator_tours.price_unit IS 'per_person | per_group | unknown — required for honest price comparison';
COMMENT ON COLUMN operator_tours.price_note IS 'Raw price text from source page for verification';
COMMENT ON COLUMN operator_tours.source_url IS 'Source page URL — shown to users, enables verification';
COMMENT ON COLUMN operator_tours.is_stale IS 'True if parsed_at > 30 days ago — warn users about data age';
