-- Migration 736: ТОЛЬКО kamchatka_routes.duration_days — атомарно, без ничего
--
-- Четыре прогона enrich подряд падали на `column r.duration_days does not
-- exist` даже ПОСЛЕ миграций 731/733/734. Разгадка в тексте ошибки: Postgres
-- жалуется на duration_days, но НЕ на distance_km/duration_hours из того же
-- SELECT — значит те колонки есть, а duration_days нет. Почему миграции его
-- не добавляли: в каждой из 731/733/734 в ОДНОЙ транзакции с колонками шёл
-- `ALTER TABLE places ADD COLUMN merged_into_id UUID REFERENCES places(id)`.
-- Этот FK на проде падает (нет подходящего ограничения на places.id — тот же
-- schema-drift) и откатывает ВСЮ транзакцию вместе с ADD COLUMN duration_days.
--
-- Здесь — ОДИН ALTER, ничего больше. Ни places, ни FK, ни view. Упасть
-- нечему, откатывать нечего. duration_days появится гарантированно.

ALTER TABLE kamchatka_routes ADD COLUMN IF NOT EXISTS duration_days INTEGER;
