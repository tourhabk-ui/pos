-- Migration 697: add telegram_chat_id to users table
-- Required by route-escalation cron: links Telegram users to registered accounts

ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_users_telegram_chat_id
  ON users (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;
