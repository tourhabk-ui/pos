-- Migration 733: полный ремонт схемы маршрутов — колонки + VIEW + merged_into_id
--
-- Прод-прогон enrich-passports вскрыл истинную причину: в kamchatka_routes на
-- этом инстансе НЕТ колонки duration_days (`column r.duration_days does not
-- exist`). VIEW v_kamchatka_routes_api (миграция 670) её селектит — значит
-- миграция 731 на проде УПАЛА на CREATE VIEW и откатилась ЦЕЛИКОМ (в одной
-- транзакции с ней был ADD COLUMN merged_into_id — он тоже не применился).
-- Отсюда: health-метрики «Треки»/«Контакты МЧС» и поиск в «Фото мест» всё
-- ещё сломаны, 731 висит как непрогнанная и падает на каждом деплое.
--
-- 733 идемпотентна и самодостаточна: сперва ГАРАНТИРУЕМ все колонки, которые
-- селектит VIEW (ADD COLUMN IF NOT EXISTS — существующие пропускаются, тип не
-- меняется), затем DROP+CREATE VIEW (гарантированно проходит) и merged_into_id.
-- Заменяет 731 (та осталась падать — здесь всё то же плюс колонки).

BEGIN;

-- ── Колонки kamchatka_routes, которые селектит VIEW (§10 + ядро) ──────────
-- Типы — из §10 CLAUDE.md и существующих чтений в коде (hazards/equipment —
-- TEXT[] читаются как string[]). IF NOT EXISTS: кураторские колонки не трогаем.
ALTER TABLE kamchatka_routes
  ADD COLUMN IF NOT EXISTS ark_id                     UUID,
  ADD COLUMN IF NOT EXISTS category                   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS activity_type              VARCHAR(100),
  ADD COLUMN IF NOT EXISTS zone                       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS source_url                 TEXT,
  ADD COLUMN IF NOT EXISTS source_name                VARCHAR(200),
  ADD COLUMN IF NOT EXISTS difficulty                 VARCHAR(20),
  ADD COLUMN IF NOT EXISTS distance_km                DECIMAL(8,2),
  ADD COLUMN IF NOT EXISTS duration_hours             DECIMAL(6,2),
  ADD COLUMN IF NOT EXISTS elevation_gain_m           INTEGER,
  ADD COLUMN IF NOT EXISTS season                     VARCHAR(20),
  ADD COLUMN IF NOT EXISTS route_type                 VARCHAR(30),
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

-- ── places.merged_into_id (миграция 706, откатилась вместе с 731) ─────────
ALTER TABLE places ADD COLUMN IF NOT EXISTS merged_into_id UUID REFERENCES places(id);
ALTER TABLE places ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_places_merged_into ON places(merged_into_id) WHERE merged_into_id IS NOT NULL;

-- ── Публичный VIEW маршрутов — теперь все колонки гарантированно есть ─────
DROP VIEW IF EXISTS v_kamchatka_routes_api;
CREATE VIEW v_kamchatka_routes_api AS
SELECT
  id, ark_id, title, description, category, activity_type, zone, lat, lng,
  source_url, source_name, difficulty, distance_km, duration_hours,
  elevation_gain_m, season, route_type, is_visible, view_count, geometry,
  hazards, equipment, mchs_registration_required, park_name, park_approval_url,
  flora_fauna, accessibility, mchs_phone, duration_days, created_at, updated_at
FROM kamchatka_routes
WHERE is_visible = true OR is_visible IS NULL;

COMMIT;
