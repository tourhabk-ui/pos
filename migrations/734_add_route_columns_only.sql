-- Migration 734: ТОЛЬКО колонки kamchatka_routes (без VIEW) — коммитятся отдельно
--
-- Три прогона enrich-passports подряд падали на `column r.duration_days does
-- not exist` уже ПОСЛЕ миграции 733, которая эту колонку добавляет. Вывод:
-- 733 добавляла колонки и создавала VIEW в ОДНОЙ транзакции, а CREATE VIEW на
-- проде падал (на неучтённой колонке или зависимости) — и откатывал всю
-- транзакцию ВМЕСТЕ с ADD COLUMN duration_days. Колонки так и не появлялись.
--
-- Здесь — ТОЛЬКО ALTER TABLE, без VIEW. Все ADD COLUMN IF NOT EXISTS не могут
-- упасть (существующие пропускаются, тип не меняется), транзакция коммитится
-- независимо. После 734 колонки гарантированно есть — enrich-passports и
-- прямые чтения заработают. Создание VIEW вынесено в отдельную 735.
--
-- Добавлены ВСЕ колонки, которые селектит v_kamchatka_routes_api (включая
-- «ядровые» title/lat/lng/is_visible — если они есть, IF NOT EXISTS их не
-- трогает; если вдруг нет — это и была причина падения CREATE VIEW в 733/735).

BEGIN;

ALTER TABLE kamchatka_routes
  ADD COLUMN IF NOT EXISTS ark_id                     UUID,
  ADD COLUMN IF NOT EXISTS title                      TEXT,
  ADD COLUMN IF NOT EXISTS description                TEXT,
  ADD COLUMN IF NOT EXISTS category                   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS activity_type              VARCHAR(100),
  ADD COLUMN IF NOT EXISTS zone                       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS lat                        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng                        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS source_url                 TEXT,
  ADD COLUMN IF NOT EXISTS source_name                VARCHAR(200),
  ADD COLUMN IF NOT EXISTS difficulty                 VARCHAR(20),
  ADD COLUMN IF NOT EXISTS distance_km                DECIMAL(8,2),
  ADD COLUMN IF NOT EXISTS duration_hours             DECIMAL(6,2),
  ADD COLUMN IF NOT EXISTS elevation_gain_m           INTEGER,
  ADD COLUMN IF NOT EXISTS season                     VARCHAR(20),
  ADD COLUMN IF NOT EXISTS route_type                 VARCHAR(30),
  ADD COLUMN IF NOT EXISTS is_visible                 BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS view_count                 INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS geometry                   JSONB,
  ADD COLUMN IF NOT EXISTS hazards                    TEXT[],
  ADD COLUMN IF NOT EXISTS equipment                  TEXT[],
  ADD COLUMN IF NOT EXISTS mchs_registration_required BOOLEAN,
  ADD COLUMN IF NOT EXISTS park_name                  VARCHAR(150),
  ADD COLUMN IF NOT EXISTS park_approval_url          TEXT,
  ADD COLUMN IF NOT EXISTS flora_fauna                TEXT,
  ADD COLUMN IF NOT EXISTS accessibility              TEXT,
  ADD COLUMN IF NOT EXISTS mchs_phone                 VARCHAR(50),
  ADD COLUMN IF NOT EXISTS duration_days              INTEGER,
  ADD COLUMN IF NOT EXISTS created_at                 TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at                 TIMESTAMPTZ DEFAULT NOW();

-- places.merged_into_id (миграция 706 / 731 — откатывалась вместе с view)
ALTER TABLE places ADD COLUMN IF NOT EXISTS merged_into_id UUID REFERENCES places(id);
ALTER TABLE places ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_places_merged_into ON places(merged_into_id) WHERE merged_into_id IS NOT NULL;

COMMIT;
