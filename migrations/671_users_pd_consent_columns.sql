-- Migration 671: Add personal data consent columns to users table
-- Required for 152-FZ compliance: tracking when and from which IP consent was given.
-- Uses ADD COLUMN IF NOT EXISTS for idempotency.

ALTER TABLE users ADD COLUMN IF NOT EXISTS pd_consent_at   TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pd_consent_ip   VARCHAR(45);
ALTER TABLE users ADD COLUMN IF NOT EXISTS pd_consent_given BOOLEAN DEFAULT FALSE;

-- Backfill: existing users are considered to have given consent at account creation time.
UPDATE users
SET
  pd_consent_given = TRUE,
  pd_consent_at    = COALESCE(pd_consent_at, created_at)
WHERE pd_consent_given IS DISTINCT FROM TRUE;

COMMENT ON COLUMN users.pd_consent_at    IS '152-ФЗ: timestamp when user gave personal data processing consent';
COMMENT ON COLUMN users.pd_consent_ip    IS '152-ФЗ: IP address from which consent was given';
COMMENT ON COLUMN users.pd_consent_given IS '152-ФЗ: whether consent has been recorded';
