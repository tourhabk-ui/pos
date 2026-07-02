-- 706_places_merge_dedup.sql
-- Мягкое слияние дублей в places (одно физическое место — несколько строк,
-- напр. "Авачинская сопка" и "Авачинский вулкан" — одна и та же гора).
-- merged_into_id — не удаляет строку, только помечает как дубль; зависимые
-- таблицы (location_safety_profile/location_real_time_status/ai_route_images
-- keyed by ark_id, route_waypoints keyed by place_id) остаются нетронутыми
-- миграцией — перенос данных делает POST /api/admin/places/merge выборочно
-- и только для того, что безопасно автоматизировать (фото, waypoints).

ALTER TABLE places ADD COLUMN IF NOT EXISTS merged_into_id UUID REFERENCES places(id);
ALTER TABLE places ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_places_merged_into ON places(merged_into_id) WHERE merged_into_id IS NOT NULL;
