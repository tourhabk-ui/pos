-- Migration 730: OCR-текст официальных PDF-паспортов маршрутов
--
-- Владелец одобрил разовый прогон ~100 паспортов (kamchatka_routes:
-- official_passport_url / pdf_url) через Mistral OCR (mistral-ocr-latest).
-- Markdown с сохранением структуры (таблицы, заголовки) складывается сюда;
-- дальнейшее обогащение карточек маршрутов (опасности, снаряжение, этапы)
-- читает из этой таблицы, не дёргая OCR повторно.
--
-- PRIMARY KEY route_id: один OCR-результат на маршрут, повторный прогон
-- обновляет (ON CONFLICT DO UPDATE в раннере).
-- Идемпотентна: safe to run multiple times.

BEGIN;

CREATE TABLE IF NOT EXISTS route_passport_ocr (
  route_id     UUID PRIMARY KEY REFERENCES kamchatka_routes(id) ON DELETE CASCADE,
  pdf_url      TEXT NOT NULL,
  markdown     TEXT NOT NULL,
  pages        INTEGER,
  model        VARCHAR(50) NOT NULL DEFAULT 'mistral-ocr-latest',
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
