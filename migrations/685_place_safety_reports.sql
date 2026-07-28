-- Migration 685: place_safety_reports
-- UGC safety conditions reported by tourists at the location.
-- No gamification. No ratings. Safety facts only.
--
-- Правка 28.07: миграция не применялась ни разу, таблицы в проде нет. Цена
-- молчания здесь выше обычной: это сообщения туристов об обстановке на месте,
-- то есть safety-канал, которого просто не существовало.
--
-- Причина — inline-FK `REFERENCES places(id)`, та же, что у 675, и с теми же
-- двумя кандидатами: несовпадение типов (`places.id` — TEXT, аудит 28.07) либо
-- отсутствие unique/PK на `places.id` (версия миграции 737). Настоящего текста
-- ошибки не было ни у кого, поэтому между гипотезами не выбираю: тип привожу к
-- TEXT, FK убираю — как это уже сделано в 737. Целостность держит прикладной
-- слой. Настоящую причину покажет `_migration_failures`.

CREATE TABLE IF NOT EXISTS place_safety_reports (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id     TEXT        NOT NULL,
  user_id      UUID,                                  -- NULL = anonymous
  is_ok        BOOLEAN     NOT NULL DEFAULT TRUE,     -- true = all clear
  conditions   TEXT[]      NOT NULL DEFAULT '{}',     -- selected condition tags
  note         TEXT        CHECK (char_length(note) <= 300),
  reporter_lat DECIMAL(9,6),
  reporter_lng DECIMAL(9,6),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_psr_place_created
  ON place_safety_reports (place_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_psr_created
  ON place_safety_reports (created_at DESC);
