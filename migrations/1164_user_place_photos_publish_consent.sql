-- Migration 1164: согласие автора на публикацию снимка места
-- Created: 2026-10-04
--
-- Решение владельца 04.10: у формы загрузки фото на карточке места должна
-- быть «кнопка для разрешения публикации». Снимок становится публичным после
-- модерации, и делать это без явного «да» автора нельзя. Колонка хранит
-- МОМЕНТ согласия: NULL у старых строк — честное «не записано», а не
-- выдуманное «да» (§4.0). Приём без согласия отвечает 400
-- (app/api/places/[id]/photos/route.ts).

BEGIN;

ALTER TABLE user_place_photos
  ADD COLUMN IF NOT EXISTS publish_consent_at TIMESTAMPTZ;

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE user_place_photos DROP COLUMN IF EXISTS publish_consent_at;
-- COMMIT;
