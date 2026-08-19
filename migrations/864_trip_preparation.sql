-- 864: План подготовки к походу (Field Confidence Navigator, этап 4).
--
-- Три таблицы доменной модели «Потребности в походе»:
--   trip_preparation_plans  — сохранённый контекст подготовки (маршрут+дата+ответы);
--   trip_preparation_items  — единицы действия/потребности с источником и причиной;
--   trip_preparation_events — audit trail изменений состояния.
--
-- Anonymous-first: план связывается с session_id (текст, не FK) ЛИБО живёт
-- локально на устройстве до первого share. user_id появляется только при
-- сохранении под аккаунтом. Экран v1 хранит план локально; таблицы — почва
-- для группового share (этап 5), когда серверное хранение получает смысл.
--
-- Идемпотентно: IF NOT EXISTS везде.

CREATE TABLE IF NOT EXISTS trip_preparation_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id        UUID NOT NULL REFERENCES kamchatka_routes(id) ON DELETE CASCADE,
  route_version   INT NOT NULL DEFAULT 1,
  session_id      TEXT,
  user_id         INT,
  departure_at    DATE,
  duration_type   VARCHAR(20),           -- under_4h | day | overnight | multi_day
  party_size      VARCHAR(20),           -- solo | group | guided
  experience      VARCHAR(20),           -- first_time | some | confident
  ownership       VARCHAR(20),           -- own_all | partial_rent | need_advice
  status          VARCHAR(20) NOT NULL DEFAULT 'active',  -- active | archived
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trip_prep_plans_route ON trip_preparation_plans(route_id);
CREATE INDEX IF NOT EXISTS idx_trip_prep_plans_session ON trip_preparation_plans(session_id) WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS trip_preparation_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id      UUID NOT NULL REFERENCES trip_preparation_plans(id) ON DELETE CASCADE,
  domain       VARCHAR(30) NOT NULL,     -- route|conditions|navigation|water_food|clothing_shelter|safety_group|logistics
  code         VARCHAR(50) NOT NULL,     -- field_pack | mchs_registration | water_plan | ...
  importance   VARCHAR(15) NOT NULL,     -- required | check | recommended
  state        VARCHAR(20) NOT NULL DEFAULT 'unknown',  -- ready|needs_action|planned|not_applicable|unknown|stale
  reason       TEXT NOT NULL,
  -- Источник обязательности. «Обязательно по мнению AI» не существует:
  -- сторож в коде (lib/preparation) не пропускает required с source_type
  -- 'ai_suggestion'; CHECK дублирует это на уровне данных.
  source_type  VARCHAR(30) NOT NULL,     -- route_passport|field_pack|official_rule|condition_snapshot|user_input|ai_suggestion
  source_ref   TEXT,
  freshness_at TIMESTAMPTZ,
  payload      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trip_prep_required_not_ai
    CHECK (NOT (importance = 'required' AND source_type = 'ai_suggestion')),
  CONSTRAINT trip_prep_item_unique UNIQUE (plan_id, code)
);

CREATE INDEX IF NOT EXISTS idx_trip_prep_items_plan ON trip_preparation_items(plan_id);

CREATE TABLE IF NOT EXISTS trip_preparation_events (
  id         BIGSERIAL PRIMARY KEY,
  plan_id    UUID NOT NULL REFERENCES trip_preparation_plans(id) ON DELETE CASCADE,
  item_id    UUID,
  event_type VARCHAR(40) NOT NULL,       -- plan_created | item_state_changed | ...
  actor      VARCHAR(20) NOT NULL DEFAULT 'user',  -- user | system
  metadata   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trip_prep_events_plan ON trip_preparation_events(plan_id);
