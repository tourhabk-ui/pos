-- Migration 952: черновики описаний мест из внешних источников
--
-- #1830: описания вулканов из Global Volcanism Program (Remarks) — перевод +
-- проверка, НЕ автовставка. Editor (route_description_cache) публикует свой
-- текст сразу — это осознанно другой случай (тур-описания, короткий цикл,
-- владелец сверяет очной ставкой моделей на промпте Editor'а, не построчно).
-- Здесь владелец явно потребовал ручное ревью КАЖДОГО текста перед публикацией
-- в `places.description` — значит нужна отдельная таблица-черновик, а не
-- прямая запись в живую колонку.
--
-- source/source_ref — откуда взят текст и чем именно (VolcanoNumber ГВП),
-- чтобы источник факта был виден тому, кто ревьюит, а не только автору кода.
-- original_text хранится РЯДОМ с переводом — ревью сверяет их очной ставкой,
-- не верит переводу на слово.

BEGIN;

CREATE TABLE IF NOT EXISTS place_description_drafts (
  place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  original_text TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT place_description_drafts_status_check
    CHECK (status IN ('pending', 'approved', 'rejected')),
  PRIMARY KEY (place_id, source)
);

CREATE INDEX IF NOT EXISTS idx_place_description_drafts_status
  ON place_description_drafts(status);

COMMIT;
