-- Migration 698: add user_name and user_email to support_tickets
-- ticket.service.ts SELECTs these columns but they were never added to the table

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS user_name  VARCHAR(255);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS user_email VARCHAR(255);
