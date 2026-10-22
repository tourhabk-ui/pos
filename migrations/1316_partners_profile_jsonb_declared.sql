-- Migration 1316: объявить JSONB-колонки профиля партнёра, которые живут на проде без миграции
-- Created: 2026-10-22
--
-- ── Зачем ─────────────────────────────────────────────────────────────────
-- partners.features, faq, season_info и reviews_data есть на проде и в
-- базовом снимке схемы (JSONB DEFAULT '[]'), их пишет 1106 и читает страница
-- оператора /operators/[slug] — но ни одна миграция их не объявляет. Сторож
-- фантомных колонок (tests/unit/sql-phantom-columns) сверяет SQL с миграциями
-- и держал их в замороженном списке долга; новый читатель — сайт партнёра на
-- его домене (lib/partner-sites/load, fishingkam.ru, 22.10) — упёрся бы в тот
-- же список. Правило сторожа: реальная колонка без миграции — это миграция,
-- а не новая запись долга.
--
-- ── Что ───────────────────────────────────────────────────────────────────
-- ADD COLUMN IF NOT EXISTS с тем же типом и умолчанием, что на проде (сверено
-- с копией базового снимка 22.10): на проде — пустая операция, на чистой базе
-- колонки появляются такими же.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE partners ADD COLUMN IF NOT EXISTS features     JSONB DEFAULT '[]'::jsonb;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS faq          JSONB DEFAULT '[]'::jsonb;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS season_info  JSONB DEFAULT '[]'::jsonb;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS reviews_data JSONB DEFAULT '[]'::jsonb;

COMMIT;

-- Rollback: не нужен — колонки существовали до миграции, она их только объявляет.
