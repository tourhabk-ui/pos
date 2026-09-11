-- 949: две таблицы кабинета туриста, которых не было НИГДЕ.
--
-- Прогулка туристом 10.09 (issue #1771): /api/tourist/wishlist (сердечки на
-- карточках, /hub/tourist/wishlist) и /api/tourist/notification-preferences
-- (/hub/tourist/notifications) читали tourist_wishlist и
-- tourist_notification_preferences. Ни одна миграция их не заводила, baseline
-- прода от 15.08 их не знает, в lib/database/*.sql их нет. Оба роута отвечали
-- 500 на каждый вызов с момента написания; список lib/db/undeclared-registry
-- честно называл их «форма неизвестна».
--
-- Форма собрана по живому коду роутов (SELECT/INSERT/UPDATE дословно), как у
-- tourist_documents (903) и tourist_profiles (943). Ключ — tourist_profiles.id,
-- потому что оба роута ходят через getTouristProfile().
--
-- Остальные таблицы того же семейства (tourist_trips, trip_bookings,
-- tourist_reviews, tourist_achievements, tourist_checklists) НЕ заводятся: их
-- читатели — роуты без единого экрана-потребителя, и они удалены тем же PR;
-- живые данные лежат в user_trips, operator_tour_reviews и user_achievements.

CREATE TABLE IF NOT EXISTS tourist_wishlist (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tourist_id             UUID NOT NULL REFERENCES tourist_profiles(id) ON DELETE CASCADE,
  item_type              VARCHAR(20) NOT NULL,
  item_id                TEXT NOT NULL,
  priority               VARCHAR(10) NOT NULL DEFAULT 'medium',
  notes                  TEXT,
  notify_on_discount     BOOLEAN NOT NULL DEFAULT FALSE,
  notify_on_availability BOOLEAN NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tourist_wishlist_unique_item UNIQUE (tourist_id, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_tourist_wishlist_tourist_type
  ON tourist_wishlist (tourist_id, item_type);

CREATE TABLE IF NOT EXISTS tourist_notification_preferences (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tourist_id                 UUID NOT NULL UNIQUE REFERENCES tourist_profiles(id) ON DELETE CASCADE,
  email_booking_confirmation BOOLEAN NOT NULL DEFAULT TRUE,
  email_booking_reminder     BOOLEAN NOT NULL DEFAULT TRUE,
  email_booking_changes      BOOLEAN NOT NULL DEFAULT TRUE,
  email_payment_receipts     BOOLEAN NOT NULL DEFAULT TRUE,
  email_promotions           BOOLEAN NOT NULL DEFAULT FALSE,
  email_newsletters          BOOLEAN NOT NULL DEFAULT FALSE,
  email_recommendations      BOOLEAN NOT NULL DEFAULT FALSE,
  email_reviews_requests     BOOLEAN NOT NULL DEFAULT TRUE,
  sms_booking_confirmation   BOOLEAN NOT NULL DEFAULT TRUE,
  sms_booking_reminder       BOOLEAN NOT NULL DEFAULT TRUE,
  sms_emergency_alerts       BOOLEAN NOT NULL DEFAULT TRUE,
  push_booking_updates       BOOLEAN NOT NULL DEFAULT TRUE,
  push_messages              BOOLEAN NOT NULL DEFAULT TRUE,
  push_promotions            BOOLEAN NOT NULL DEFAULT FALSE,
  push_recommendations       BOOLEAN NOT NULL DEFAULT FALSE,
  language                   VARCHAR(8)  NOT NULL DEFAULT 'ru',
  timezone                   VARCHAR(64) NOT NULL DEFAULT 'Asia/Kamchatka',
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
