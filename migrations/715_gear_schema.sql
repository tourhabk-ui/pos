-- Migration 715: схема аренды снаряжения (gear) — в пайплайн миграций
--
-- Проблема: таблицы gear_* жили только в lib/database/gear_schema.sql, который
-- никто не применяет, и его форма расходится с кодом по всем трём таблицам:
--   - gear_items: в коде есть partner_id, price_per_month, insurance_cost_per_day,
--     features, total_revenue — в старой схеме их нет; tags в коде — TEXT[]
--     (INSERT кладёт массив как есть, витрина фильтрует оператором &&),
--     в старой схеме — JSONB;
--   - gear_rentals: код пишет плоскую форму (gear_id, customer_*, days_count,
--     base_price, total_price, comments), старая схема — customer_info/items JSONB
--     с NOT NULL, которые ломали бы INSERT;
--   - gear_availability: код ходит по колонке gear_item_id и ON CONFLICT
--     (gear_item_id, date), в старой схеме колонка называется gear_id.
--
-- Эта миграция приводит БД к форме, которую реально требует код
-- (app/api/gear/*, lib/auth/gear-helpers.ts), в обоих мирах:
-- таблиц нет → создаются правильно; есть в старой форме → добираются.
--
-- Идемпотентна: safe to run multiple times.

BEGIN;

-- ── Step 1: gear_items в форме items-роута и хелперов ────────────────────────
CREATE TABLE IF NOT EXISTS gear_items (
  id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id             UUID          REFERENCES partners(id) ON DELETE CASCADE,
  name                   VARCHAR(255)  NOT NULL,
  description            TEXT,
  category               VARCHAR(50)   NOT NULL,
  subcategory            VARCHAR(100),
  brand                  VARCHAR(100),
  model                  VARCHAR(100),
  price_per_day          DECIMAL(10,2) NOT NULL,
  price_per_week         DECIMAL(10,2),
  price_per_month        DECIMAL(10,2),
  quantity               INTEGER       NOT NULL DEFAULT 1,
  available_quantity     INTEGER       NOT NULL DEFAULT 1,
  deposit_amount         DECIMAL(10,2),
  insurance_cost_per_day DECIMAL(10,2),
  images                 JSONB         DEFAULT '[]',
  specifications         JSONB         DEFAULT '{}',
  features               JSONB         DEFAULT '[]',
  condition              VARCHAR(20)   DEFAULT 'excellent',
  tags                   TEXT[]        DEFAULT '{}',
  rating                 DECIMAL(3,2)  DEFAULT 0.0,
  review_count           INTEGER       DEFAULT 0,
  rental_count           INTEGER       DEFAULT 0,
  total_revenue          DECIMAL(12,2) DEFAULT 0,
  is_active              BOOLEAN       DEFAULT TRUE,
  created_at             TIMESTAMPTZ   DEFAULT NOW(),
  updated_at             TIMESTAMPTZ   DEFAULT NOW()
);

-- Таблица могла быть создана вручную по старому gear_schema.sql — добираем.
ALTER TABLE gear_items ADD COLUMN IF NOT EXISTS partner_id             UUID;
ALTER TABLE gear_items ADD COLUMN IF NOT EXISTS price_per_month        DECIMAL(10,2);
ALTER TABLE gear_items ADD COLUMN IF NOT EXISTS insurance_cost_per_day DECIMAL(10,2);
ALTER TABLE gear_items ADD COLUMN IF NOT EXISTS features               JSONB DEFAULT '[]';
ALTER TABLE gear_items ADD COLUMN IF NOT EXISTS total_revenue          DECIMAL(12,2) DEFAULT 0;
ALTER TABLE gear_items ADD COLUMN IF NOT EXISTS rating                 DECIMAL(3,2) DEFAULT 0.0;
ALTER TABLE gear_items ADD COLUMN IF NOT EXISTS review_count           INTEGER DEFAULT 0;
ALTER TABLE gear_items ADD COLUMN IF NOT EXISTS rental_count           INTEGER DEFAULT 0;

-- description в старой схеме NOT NULL, в коде — опциональное поле.
ALTER TABLE gear_items ALTER COLUMN description DROP NOT NULL;

-- tags JSONB из старой схемы ломает и INSERT (кладётся текстовый массив),
-- и фильтр витрины (оператор && определён для массивов) → переводим в TEXT[].
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'gear_items'
      AND column_name  = 'tags'
      AND data_type    = 'jsonb'
  ) THEN
    ALTER TABLE gear_items ALTER COLUMN tags DROP DEFAULT;
    ALTER TABLE gear_items ALTER COLUMN tags TYPE TEXT[] USING (
      CASE
        WHEN tags IS NULL OR jsonb_typeof(tags) <> 'array' THEN '{}'::TEXT[]
        ELSE ARRAY(SELECT jsonb_array_elements_text(tags))
      END
    );
    ALTER TABLE gear_items ALTER COLUMN tags SET DEFAULT '{}';
    RAISE NOTICE 'Migration 715: gear_items.tags JSONB -> TEXT[]';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gear_items_partner_id ON gear_items (partner_id);
CREATE INDEX IF NOT EXISTS idx_gear_items_category   ON gear_items (category);
CREATE INDEX IF NOT EXISTS idx_gear_items_is_active  ON gear_items (is_active);

-- ── Step 2: gear_rentals в форме rentals-роута ───────────────────────────────
CREATE TABLE IF NOT EXISTS gear_rentals (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  gear_id        UUID          NOT NULL REFERENCES gear_items(id) ON DELETE CASCADE,
  customer_name  VARCHAR(255)  NOT NULL,
  customer_email VARCHAR(255)  NOT NULL,
  customer_phone VARCHAR(50)   NOT NULL,
  start_date     DATE          NOT NULL,
  end_date       DATE          NOT NULL,
  quantity       INTEGER       NOT NULL DEFAULT 1,
  days_count     INTEGER       NOT NULL,
  insurance      BOOLEAN       DEFAULT FALSE,
  base_price     DECIMAL(12,2) NOT NULL,
  insurance_cost DECIMAL(10,2) DEFAULT 0,
  total_price    DECIMAL(12,2) NOT NULL,
  comments       TEXT,
  status         VARCHAR(20)   NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'active', 'completed', 'cancelled', 'overdue')),
  created_at     TIMESTAMPTZ   DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   DEFAULT NOW()
);

-- Таблица могла существовать в старой форме (customer_info/items JSONB) —
-- добираем колонки кода и снимаем NOT NULL со старых, чтобы INSERT кода проходил.
ALTER TABLE gear_rentals ADD COLUMN IF NOT EXISTS gear_id        UUID;
ALTER TABLE gear_rentals ADD COLUMN IF NOT EXISTS customer_name  VARCHAR(255);
ALTER TABLE gear_rentals ADD COLUMN IF NOT EXISTS customer_email VARCHAR(255);
ALTER TABLE gear_rentals ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(50);
ALTER TABLE gear_rentals ADD COLUMN IF NOT EXISTS quantity       INTEGER DEFAULT 1;
ALTER TABLE gear_rentals ADD COLUMN IF NOT EXISTS days_count     INTEGER;
ALTER TABLE gear_rentals ADD COLUMN IF NOT EXISTS insurance      BOOLEAN DEFAULT FALSE;
ALTER TABLE gear_rentals ADD COLUMN IF NOT EXISTS base_price     DECIMAL(12,2);
ALTER TABLE gear_rentals ADD COLUMN IF NOT EXISTS insurance_cost DECIMAL(10,2) DEFAULT 0;
ALTER TABLE gear_rentals ADD COLUMN IF NOT EXISTS total_price    DECIMAL(12,2);
ALTER TABLE gear_rentals ADD COLUMN IF NOT EXISTS comments       TEXT;
ALTER TABLE gear_rentals ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ DEFAULT NOW();

DO $$
DECLARE col TEXT;
BEGIN
  FOREACH col IN ARRAY ARRAY['customer_info', 'items', 'total_days', 'rental_cost', 'total']
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'gear_rentals'
        AND column_name  = col
        AND is_nullable  = 'NO'
    ) THEN
      EXECUTE format('ALTER TABLE gear_rentals ALTER COLUMN %I DROP NOT NULL', col);
      RAISE NOTICE 'Migration 715: gear_rentals.% -> NULLABLE (legacy)', col;
    END IF;
  END LOOP;
END $$;

-- Единый CHECK статусов (в старой форме его не было).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'gear_rentals'::regclass
      AND conname  = 'gear_rentals_status_check'
  ) THEN
    ALTER TABLE gear_rentals ADD CONSTRAINT gear_rentals_status_check
      CHECK (status IN ('pending', 'confirmed', 'active', 'completed', 'cancelled', 'overdue'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gear_rentals_gear_id ON gear_rentals (gear_id);
CREATE INDEX IF NOT EXISTS idx_gear_rentals_status  ON gear_rentals (status);
CREATE INDEX IF NOT EXISTS idx_gear_rentals_dates   ON gear_rentals (start_date, end_date);

-- ── Step 3: gear_availability в форме хелперов (gear_item_id) ────────────────
CREATE TABLE IF NOT EXISTS gear_availability (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  gear_item_id       UUID        NOT NULL REFERENCES gear_items(id) ON DELETE CASCADE,
  date               DATE        NOT NULL,
  total_quantity     INTEGER     NOT NULL,
  rented_quantity    INTEGER     DEFAULT 0,
  available_quantity INTEGER     NOT NULL,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (gear_item_id, date)
);

-- Старая форма называла колонку gear_id — переименовываем под код
-- (checkGearAvailability, updateGearAvailability: ON CONFLICT (gear_item_id, date)).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'gear_availability' AND column_name = 'gear_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'gear_availability' AND column_name = 'gear_item_id'
  ) THEN
    ALTER TABLE gear_availability RENAME COLUMN gear_id TO gear_item_id;
    RAISE NOTICE 'Migration 715: gear_availability.gear_id -> gear_item_id';
  END IF;
END $$;

-- ON CONFLICT (gear_item_id, date) требует уникальность именно по этой паре.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'gear_availability'::regclass
      AND c.contype = 'u'
      AND (
        SELECT array_agg(a.attname ORDER BY a.attname)
        FROM unnest(c.conkey) AS colnum
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = colnum
      ) = ARRAY['date', 'gear_item_id']::name[]
  ) THEN
    ALTER TABLE gear_availability
      ADD CONSTRAINT gear_availability_item_date_key UNIQUE (gear_item_id, date);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gear_availability_item_date
  ON gear_availability (gear_item_id, date);

COMMIT;
