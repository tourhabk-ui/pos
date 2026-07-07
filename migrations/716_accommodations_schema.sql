-- Migration 716: схема размещения (accommodations) — в пайплайн миграций
--
-- Проблема: вся DDL домена жилья жила только в lib/database/accommodation_schema.sql,
-- который никто не применяет. На свежем инстансе витрина /stay и бронирование
-- (POST /api/accommodations/[id]/book) падают на первом же запросе.
-- Вдобавок таблица accommodation_assets (фото объектов; используется листингом,
-- карточкой и админским create) не существовала НИ В ОДНОМ DDL вообще.
--
-- Форма — из фактического кода (book-роут canonical: check_in_date/check_out_date,
-- nights, room_price_per_night, total_price, status/payment_status).
-- uuid_generate_v4 из старого файла заменён на gen_random_uuid (без uuid-ossp).
--
-- Идемпотентна: safe to run multiple times.

BEGIN;

-- ── Step 1: accommodations ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accommodations (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id           UUID          REFERENCES partners(id) ON DELETE CASCADE,
  name                 VARCHAR(255)  NOT NULL,
  type                 VARCHAR(50)   NOT NULL CHECK (type IN ('hotel', 'hostel', 'apartment', 'guesthouse', 'resort', 'camping', 'glamping', 'cottage')),
  description          TEXT,
  short_description    VARCHAR(500),
  address              VARCHAR(500)  NOT NULL,
  coordinates          JSONB         NOT NULL,
  location_zone        VARCHAR(100),
  star_rating          INTEGER       CHECK (star_rating >= 1 AND star_rating <= 5),
  total_rooms          INTEGER       NOT NULL CHECK (total_rooms > 0),
  check_in_time        TIME          DEFAULT '14:00',
  check_out_time       TIME          DEFAULT '12:00',
  amenities            JSONB         DEFAULT '[]',
  languages            JSONB         DEFAULT '["ru"]',
  price_per_night_from DECIMAL(10,2) NOT NULL,
  price_per_night_to   DECIMAL(10,2),
  currency             VARCHAR(3)    DEFAULT 'RUB',
  rating               DECIMAL(3,2)  DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
  review_count         INTEGER       DEFAULT 0,
  is_active            BOOLEAN       DEFAULT true,
  is_verified          BOOLEAN       DEFAULT false,
  created_at           TIMESTAMPTZ   DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accommodations_partner ON accommodations (partner_id);
CREATE INDEX IF NOT EXISTS idx_accommodations_type    ON accommodations (type);
CREATE INDEX IF NOT EXISTS idx_accommodations_zone    ON accommodations (location_zone);
CREATE INDEX IF NOT EXISTS idx_accommodations_rating  ON accommodations (rating DESC);
CREATE INDEX IF NOT EXISTS idx_accommodations_price   ON accommodations (price_per_night_from);
CREATE INDEX IF NOT EXISTS idx_accommodations_active  ON accommodations (is_active);

-- ── Step 2: accommodation_rooms ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accommodation_rooms (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  accommodation_id   UUID          REFERENCES accommodations(id) ON DELETE CASCADE,
  name               VARCHAR(255)  NOT NULL,
  room_type          VARCHAR(50)   NOT NULL CHECK (room_type IN ('single', 'double', 'twin', 'triple', 'suite', 'family', 'dormitory')),
  description        TEXT,
  size_sqm           INTEGER,
  max_guests         INTEGER       NOT NULL CHECK (max_guests > 0),
  beds_configuration JSONB,
  amenities          JSONB         DEFAULT '[]',
  view               VARCHAR(50),
  available_rooms    INTEGER       NOT NULL CHECK (available_rooms >= 0),
  price_per_night    DECIMAL(10,2) NOT NULL,
  is_active          BOOLEAN       DEFAULT true,
  created_at         TIMESTAMPTZ   DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accommodation_rooms_accommodation ON accommodation_rooms (accommodation_id);
CREATE INDEX IF NOT EXISTS idx_accommodation_rooms_type          ON accommodation_rooms (room_type);
CREATE INDEX IF NOT EXISTS idx_accommodation_rooms_price         ON accommodation_rooms (price_per_night);

-- ── Step 3: accommodation_bookings (форма book-роута) ────────────────────────
CREATE TABLE IF NOT EXISTS accommodation_bookings (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID          REFERENCES users(id),
  accommodation_id     UUID          REFERENCES accommodations(id),
  room_id              UUID          REFERENCES accommodation_rooms(id),
  check_in_date        DATE          NOT NULL,
  check_out_date       DATE          NOT NULL,
  nights               INTEGER       NOT NULL CHECK (nights > 0),
  adults               INTEGER       NOT NULL CHECK (adults > 0),
  children             INTEGER       DEFAULT 0 CHECK (children >= 0),
  room_price_per_night DECIMAL(10,2) NOT NULL,
  total_price          DECIMAL(10,2) NOT NULL,
  currency             VARCHAR(3)    DEFAULT 'RUB',
  status               VARCHAR(20)   DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')),
  payment_status       VARCHAR(20)   DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'refunded', 'partially_refunded')),
  special_requests     TEXT,
  guest_notes          TEXT,
  created_at           TIMESTAMPTZ   DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   DEFAULT NOW(),
  CONSTRAINT check_dates CHECK (check_out_date > check_in_date)
);

CREATE INDEX IF NOT EXISTS idx_accommodation_bookings_user          ON accommodation_bookings (user_id);
CREATE INDEX IF NOT EXISTS idx_accommodation_bookings_accommodation ON accommodation_bookings (accommodation_id);
CREATE INDEX IF NOT EXISTS idx_accommodation_bookings_room          ON accommodation_bookings (room_id);
CREATE INDEX IF NOT EXISTS idx_accommodation_bookings_dates         ON accommodation_bookings (check_in_date, check_out_date);
CREATE INDEX IF NOT EXISTS idx_accommodation_bookings_status        ON accommodation_bookings (status);

-- ── Step 4: accommodation_reviews ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accommodation_reviews (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        REFERENCES users(id),
  accommodation_id   UUID        REFERENCES accommodations(id),
  booking_id         UUID        REFERENCES accommodation_bookings(id),
  cleanliness_rating INTEGER     CHECK (cleanliness_rating >= 1 AND cleanliness_rating <= 5),
  service_rating     INTEGER     CHECK (service_rating >= 1 AND service_rating <= 5),
  location_rating    INTEGER     CHECK (location_rating >= 1 AND location_rating <= 5),
  value_rating       INTEGER     CHECK (value_rating >= 1 AND value_rating <= 5),
  overall_rating     INTEGER     NOT NULL CHECK (overall_rating >= 1 AND overall_rating <= 5),
  title              VARCHAR(255),
  comment            TEXT,
  is_verified        BOOLEAN     DEFAULT false,
  is_visible         BOOLEAN     DEFAULT true,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accommodation_reviews_accommodation ON accommodation_reviews (accommodation_id);
CREATE INDEX IF NOT EXISTS idx_accommodation_reviews_user          ON accommodation_reviews (user_id);

-- ── Step 5: accommodation_assets (фото; не было ни в одном DDL) ──────────────
CREATE TABLE IF NOT EXISTS accommodation_assets (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  accommodation_id UUID        NOT NULL REFERENCES accommodations(id) ON DELETE CASCADE,
  asset_id         UUID        NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (accommodation_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_accommodation_assets_accommodation
  ON accommodation_assets (accommodation_id);

-- ── Step 6: триггеры (идемпотентно: DROP IF EXISTS + CREATE) ─────────────────
CREATE OR REPLACE FUNCTION calculate_nights() RETURNS TRIGGER AS $$
BEGIN
  NEW.nights := NEW.check_out_date - NEW.check_in_date;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_calculate_nights ON accommodation_bookings;
CREATE TRIGGER trg_calculate_nights
  BEFORE INSERT OR UPDATE ON accommodation_bookings
  FOR EACH ROW
  EXECUTE FUNCTION calculate_nights();

CREATE OR REPLACE FUNCTION update_accommodation_rating() RETURNS TRIGGER AS $$
BEGIN
  UPDATE accommodations
  SET
    rating = (
      SELECT AVG(overall_rating)::DECIMAL(3,2)
      FROM accommodation_reviews
      WHERE accommodation_id = NEW.accommodation_id AND is_visible = true
    ),
    review_count = (
      SELECT COUNT(*)
      FROM accommodation_reviews
      WHERE accommodation_id = NEW.accommodation_id AND is_visible = true
    ),
    updated_at = NOW()
  WHERE id = NEW.accommodation_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_accommodation_rating ON accommodation_reviews;
CREATE TRIGGER trg_update_accommodation_rating
  AFTER INSERT OR UPDATE ON accommodation_reviews
  FOR EACH ROW
  WHEN (NEW.is_visible = true)
  EXECUTE FUNCTION update_accommodation_rating();

-- updated_at — через существующую update_updated_at_column() (migration 02),
-- не плодим дубликат функции.
DROP TRIGGER IF EXISTS trg_accommodations_updated_at ON accommodations;
CREATE TRIGGER trg_accommodations_updated_at
  BEFORE UPDATE ON accommodations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_accommodation_rooms_updated_at ON accommodation_rooms;
CREATE TRIGGER trg_accommodation_rooms_updated_at
  BEFORE UPDATE ON accommodation_rooms
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_accommodation_bookings_updated_at ON accommodation_bookings;
CREATE TRIGGER trg_accommodation_bookings_updated_at
  BEFORE UPDATE ON accommodation_bookings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMIT;
