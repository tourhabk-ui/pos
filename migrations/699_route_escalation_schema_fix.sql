-- Migration 699: fix route_registrations and route_registration_notifications
-- 1. Add reminder_sent column referenced by route-escalation cron
-- 2. Expand channel constraint to include values used by step 4 escalation

ALTER TABLE route_registrations
  ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE route_registration_notifications
  DROP CONSTRAINT IF EXISTS route_registration_notifications_channel_check;

ALTER TABLE route_registration_notifications
  ADD CONSTRAINT route_registration_notifications_channel_check
  CHECK (channel IN ('telegram', 'email', 'max', 'none', 'telegram+email', 'admin_only'));
