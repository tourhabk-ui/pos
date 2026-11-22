-- Migration 1496: одноразовая ссылка входа из Telegram (/login).
-- Created: 2026-11-22
--
-- Ссылка входа на сайт из бота срабатывает один раз: при входе её id
-- погашается здесь одной вставкой (ON CONFLICT DO NOTHING) — вторая попытка
-- с той же ссылкой вставку не делает и входа не получает. Хранится только
-- случайный id ссылки, не сама ссылка и не токен.
CREATE TABLE IF NOT EXISTS magic_link_redemptions (
  jti         UUID PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_magic_link_redemptions_redeemed_at
  ON magic_link_redemptions (redeemed_at);
