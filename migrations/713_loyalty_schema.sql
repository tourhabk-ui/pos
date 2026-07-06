-- Migration 713: схема лояльности — в пайплайн миграций
--
-- Проблема: вся DDL системы лояльности жила только в lib/database/loyalty_schema.sql,
-- который НИКТО не применяет (ни одна миграция не создаёт loyalty_transactions,
-- referrals, promo_codes и колонки users.total_spent/referral_code/referred_by).
-- При этом все начисления в коде — fire-and-forget с .catch(() => {}), поэтому
-- отсутствие таблиц/колонок падало молча. Вдобавок старый файл схемы расходится
-- с кодом: в нём нет колонки source (код её пишет), а booking_id — UUID с FK на
-- transfer_bookings, тогда как код кладёт туда id отзывов (integer) и id юзеров
-- (полиморфная ссылка на сущность-источник).
--
-- Эта миграция приводит БД к форме, которую реально требует код
-- (lib/loyalty/loyalty-system.ts), в обоих мирах:
--   - таблиц нет → создаются в правильной форме
--   - таблицы есть в старой форме → добираются колонки, booking_id становится TEXT
--
-- Идемпотентна: safe to run multiple times.

BEGIN;

-- ── Step 1: колонки users, которые читает getUserLoyaltyStats ────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_spent   DECIMAL(12,2) DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by   UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code
  ON users (referral_code) WHERE referral_code IS NOT NULL;

-- ── Step 2: loyalty_transactions в форме, которую пишет код ──────────────────
-- booking_id — TEXT без FK: полиморфная ссылка (id брони / отзыва / юзера).
CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id          VARCHAR(50) PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(20) NOT NULL CHECK (type IN ('earn', 'redeem', 'expire', 'refund')),
  amount      INTEGER     NOT NULL CHECK (amount > 0),
  source      VARCHAR(50) NOT NULL DEFAULT 'booking',
  description TEXT        NOT NULL,
  booking_id  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ
);

-- Таблица могла быть создана вручную по старому loyalty_schema.sql — добираем.
ALTER TABLE loyalty_transactions ADD COLUMN IF NOT EXISTS source VARCHAR(50) NOT NULL DEFAULT 'booking';

-- booking_id UUID (+FK на transfer_bookings) из старой схемы ломает вставку
-- id отзывов/юзеров → снимаем FK именно с booking_id и переводим в TEXT.
DO $$
DECLARE fk RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'loyalty_transactions'
      AND column_name  = 'booking_id'
      AND data_type    = 'uuid'
  ) THEN
    FOR fk IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN unnest(c.conkey) AS colnum ON TRUE
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = colnum
      WHERE c.conrelid = 'loyalty_transactions'::regclass
        AND c.contype = 'f'
        AND a.attname = 'booking_id'
    LOOP
      EXECUTE format('ALTER TABLE loyalty_transactions DROP CONSTRAINT %I', fk.conname);
    END LOOP;

    ALTER TABLE loyalty_transactions ALTER COLUMN booking_id TYPE TEXT USING booking_id::text;
    RAISE NOTICE 'Migration 713: loyalty_transactions.booking_id UUID -> TEXT';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_user_id    ON loyalty_transactions (user_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_type       ON loyalty_transactions (type);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_expires_at ON loyalty_transactions (expires_at);
-- Дедуп-проверка earnActivityPoints ищет по (user_id, source, booking_id)
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_dedup
  ON loyalty_transactions (user_id, source, booking_id);

-- ── Step 3: referrals (completeReferral / getUserLoyaltyStats) ────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referral_code VARCHAR(20) NOT NULL,
  status        VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'expired')),
  reward_amount INTEGER     DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  UNIQUE (referrer_id, referred_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals (referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred_id ON referrals (referred_id);

-- ── Step 4: promo_codes (applyPromoCode) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_codes (
  id             VARCHAR(50)   PRIMARY KEY,
  code           VARCHAR(50)   UNIQUE NOT NULL,
  discount_type  VARCHAR(20)   NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value DECIMAL(10,2) NOT NULL CHECK (discount_value > 0),
  max_uses       INTEGER       NOT NULL CHECK (max_uses > 0),
  current_uses   INTEGER       DEFAULT 0 CHECK (current_uses >= 0),
  expires_at     TIMESTAMPTZ,
  is_active      BOOLEAN       DEFAULT true,
  created_at     TIMESTAMPTZ   DEFAULT NOW(),
  created_by     UUID
);

CREATE INDEX IF NOT EXISTS idx_promo_codes_code      ON promo_codes (code);
CREATE INDEX IF NOT EXISTS idx_promo_codes_is_active ON promo_codes (is_active);

COMMIT;
