-- 728_volcano_acc_status.sql
-- Авиационные цветовые коды (ACC) вулканов Камчатки — по данным KVERT.
-- ICAO-стандарт: green/yellow/orange/red (+ unassigned до первого наблюдения).
-- Обновляется синком KVERT VONA (lib/agents/kvert-sync.ts) или вручную админом
-- (PATCH /api/admin/safety/kvert-sync). Показывается бейджем на карточке вулкана.
--
-- Идемпотентно: CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS volcano_status (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place_ark_id        UUID REFERENCES places(ark_id) ON DELETE SET NULL,
  volcano_name        TEXT NOT NULL,
  name_normalized     TEXT NOT NULL UNIQUE,
  aviation_color_code TEXT NOT NULL DEFAULT 'unassigned'
                        CHECK (aviation_color_code IN ('green','yellow','orange','red','unassigned')),
  activity_level      TEXT,
  ash_height_m        INTEGER,
  summary             TEXT,
  source_url          TEXT,
  source_name         TEXT DEFAULT 'KVERT',
  observed_at         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Быстрый JOIN с карточкой места (только у вулканов с привязкой)
CREATE INDEX IF NOT EXISTS idx_volcano_status_place
  ON volcano_status(place_ark_id) WHERE place_ark_id IS NOT NULL;
