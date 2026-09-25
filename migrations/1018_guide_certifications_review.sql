-- 1018: аттестат гида — кто его принёс и кто проверил.
--
-- ── Что было ──────────────────────────────────────────────────────────────
-- Единственный писатель guide_certifications — импорт реестра края
-- (lib/services/ingest/visitkamchatka-guides.ts): без даты выдачи и сразу с
-- is_verified = true, то есть «подтверждено» без взгляда человека. Гид сам
-- внести или обновить аттестат не мог ничем, хотя до срока переаттестации
-- (01.10) именно дата выдачи решает, нужна ли она (lib/guides/reattestation.ts).
--
-- is_verified одной булевой колонкой не различает три состояния: «ждёт
-- проверки», «проверили и отклонили», «подтверждено». Отсюда:
--   reviewed_at / reviewed_by — был ли взгляд администратора и чей;
--     is_verified = false и reviewed_at IS NULL  → ждёт проверки;
--     is_verified = false и reviewed_at NOT NULL → отклонено (см. комментарий);
--   review_comment — почему отклонено: гид видит это у себя в кабинете;
--   source — откуда запись: 'import' (импорт реестра), 'guide' (гид внёс сам).
--     NULL — не записано: у строк до этой миграции источник НЕ выводится —
--     писатель в коде один, но строки на проде могли прийти и иначе, и
--     приписать их импорту значило бы выдумать происхождение (§4.0).

ALTER TABLE guide_certifications ADD COLUMN IF NOT EXISTS source         TEXT;
ALTER TABLE guide_certifications ADD COLUMN IF NOT EXISTS reviewed_at    TIMESTAMPTZ;
ALTER TABLE guide_certifications ADD COLUMN IF NOT EXISTS reviewed_by    UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE guide_certifications ADD COLUMN IF NOT EXISTS review_comment TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'guide_certifications_source_check'
  ) THEN
    ALTER TABLE guide_certifications
      ADD CONSTRAINT guide_certifications_source_check
      CHECK (source IS NULL OR source IN ('import', 'guide'));
  END IF;
END $$;

COMMENT ON COLUMN guide_certifications.source IS
  'Откуда запись: import (импорт реестра края), guide (гид внёс в кабинете). NULL — не записано.';
COMMENT ON COLUMN guide_certifications.reviewed_at IS
  'Когда администратор принял решение. NULL при is_verified=false — ждёт проверки.';
COMMENT ON COLUMN guide_certifications.review_comment IS
  'Причина отказа администратора; показывается гиду.';
