-- Migration 1146: аудит снимков мест — отпечаток восприятия и вердикт зрения
-- Created: 2026-10-03
--
-- Владелец 03.10 (витрина термальных источников: один кадр у Ходуткинских и
-- Нижне-Вилючинских, водяной знак фотостока): «нужен инструмент сравнения
-- фото с местом из открытых источников, чтоб не было ошибок и дублей одного
-- фото на разных геоточках».
--
-- Две колонки результата и две даты. phash — dHash 64 бита (16 hex): один
-- кадр, пережатый или уменьшенный, даёт близкий отпечаток, md5 байтов такого
-- не видит. vision_verdict — ответ модели зрения по трём вопросам с тремя
-- исходами каждый (водяной знак, род места, что изображено) — подсказка для
-- разбора глазами, не приговор. Снимок с показа снимает только человек.
-- Правило и разбор — lib/images/photo-audit.ts, запись — /api/cron/photo-audit.

BEGIN;

ALTER TABLE ai_route_images ADD COLUMN IF NOT EXISTS phash          VARCHAR(16);
ALTER TABLE ai_route_images ADD COLUMN IF NOT EXISTS phash_at       TIMESTAMPTZ;
ALTER TABLE ai_route_images ADD COLUMN IF NOT EXISTS vision_verdict JSONB;
ALTER TABLE ai_route_images ADD COLUMN IF NOT EXISTS vision_at      TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ai_route_images_phash ON ai_route_images (phash) WHERE phash IS NOT NULL;

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP INDEX IF EXISTS idx_ai_route_images_phash;
-- ALTER TABLE ai_route_images DROP COLUMN IF EXISTS phash;
-- ALTER TABLE ai_route_images DROP COLUMN IF EXISTS phash_at;
-- ALTER TABLE ai_route_images DROP COLUMN IF EXISTS vision_verdict;
-- ALTER TABLE ai_route_images DROP COLUMN IF EXISTS vision_at;
-- COMMIT;
