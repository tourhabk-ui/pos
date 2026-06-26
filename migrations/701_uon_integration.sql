-- U-ON.Travel CRM integration
-- uon_api_key on partners — set per-operator, optional
-- uon_request_id on operator_bookings — populated after sync

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS uon_api_key TEXT,
  ADD COLUMN IF NOT EXISTS uon_company_id INTEGER;

ALTER TABLE operator_bookings
  ADD COLUMN IF NOT EXISTS uon_request_id INTEGER,
  ADD COLUMN IF NOT EXISTS uon_synced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_operator_bookings_uon_request_id
  ON operator_bookings (uon_request_id)
  WHERE uon_request_id IS NOT NULL;
