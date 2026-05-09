-- 663: trip_plans — AI-генерируемые офлайн-маршруты для туристов
-- Анонимные планы хранятся по session_id, авторизованные — по user_id

CREATE TABLE IF NOT EXISTS trip_plans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id      UUID NOT NULL REFERENCES kamchatka_routes(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  session_id    TEXT NOT NULL,           -- анонимный идентификатор из localStorage
  title         TEXT NOT NULL,
  start_date    DATE,
  days          SMALLINT NOT NULL DEFAULT 1,
  experience    VARCHAR(20) NOT NULL DEFAULT 'intermediate'
                CHECK (experience IN ('beginner', 'intermediate', 'advanced')),
  itinerary     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trip_plans_session ON trip_plans(session_id);
CREATE INDEX IF NOT EXISTS idx_trip_plans_user    ON trip_plans(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trip_plans_route   ON trip_plans(route_id);
