-- Migration 799: вход через MAX (бот-авторизация РФ-пользователей)
--
-- MAX не даёт классического OAuth-редиректа: вход строится через бота —
-- deep-link в наш модерированный бот, пользователь жмёт «Старт», бот получает
-- его MAX user_id и подтверждает одноразовую сессию входа. Зеркалит наш вход
-- через Telegram (users.telegram_id). Телефон на входе НЕ требуем (решение
-- владельца) — идентификация по max_user_id; телефон добираем позже при брони.
--
-- Идемпотентна.

-- ── Привязка аккаунта к MAX ─────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_user_id  BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_username TEXT;

-- Один MAX-аккаунт = один пользователь (частичный уникальный, NULL не мешают).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_max_user_id
  ON users (max_user_id) WHERE max_user_id IS NOT NULL;

-- ── Одноразовые сессии входа ────────────────────────────────────────────────
-- nonce выдаётся сайтом в deep-link, бот подтверждает его при bot_started.
-- status: pending → authenticated. consumed — защита от повторной выдачи JWT.
CREATE TABLE IF NOT EXISTS max_login_sessions (
  nonce            TEXT PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'pending',
  max_user_id      BIGINT,
  max_name         TEXT,
  max_username     TEXT,
  consumed         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  authenticated_at TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_max_login_sessions_expires
  ON max_login_sessions (expires_at);
