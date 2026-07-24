-- Период привыкания для сторожа источников: на свежей таблице (миграция 768)
-- каналы без истории ложно помечались «ни разу не дал данных» на первом же
-- прогоне. first_seen_at фиксирует, когда источник начали наблюдать; сторож не
-- судит «never/silent», пока не прошёл полный порог тишины с этого момента.
ALTER TABLE safety_source_health ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;
UPDATE safety_source_health SET first_seen_at = COALESCE(first_seen_at, last_run_at, NOW())
 WHERE first_seen_at IS NULL;
