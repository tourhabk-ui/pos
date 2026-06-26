-- Tour Selections — наш аналог Qui-Quo
-- Оператор (или Кузьмич) собирает подборку туров для конкретного клиента,
-- получает публичную ссылку /p/КОД, видит трекинг открытий и кликов.

CREATE TABLE IF NOT EXISTS tour_selections (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  code        VARCHAR(16) UNIQUE NOT NULL,          -- short URL: vedarai.ru/p/CODE
  title       TEXT,                                  -- «Туры для Тараса, август»
  client_name TEXT,
  client_phone TEXT,
  client_telegram TEXT,
  operator_id UUID REFERENCES partners(id) ON DELETE SET NULL,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_via VARCHAR(20) DEFAULT 'hub',             -- 'hub' | 'kuzmich' | 'api'
  expires_at  TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tour_selection_items (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  selection_id    UUID NOT NULL REFERENCES tour_selections(id) ON DELETE CASCADE,
  operator_tour_id INTEGER NOT NULL REFERENCES operator_tours(id) ON DELETE CASCADE,
  position        INTEGER DEFAULT 0,
  note            TEXT,                              -- заметка оператора по этому туру
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tour_selection_events (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  selection_id UUID NOT NULL REFERENCES tour_selections(id) ON DELETE CASCADE,
  item_id      UUID REFERENCES tour_selection_items(id) ON DELETE SET NULL,
  event_type   VARCHAR(20) NOT NULL,                 -- 'open' | 'tour_view' | 'book_click'
  visitor_ip   TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tour_selections_code ON tour_selections(code);
CREATE INDEX IF NOT EXISTS idx_tour_selections_operator ON tour_selections(operator_id);
CREATE INDEX IF NOT EXISTS idx_tour_selection_items_sel ON tour_selection_items(selection_id, position);
CREATE INDEX IF NOT EXISTS idx_tour_selection_events_sel ON tour_selection_events(selection_id, created_at DESC);
