-- Migration 1360: документ гида (.docx) из MAX → поля тура — черновик до кнопки
-- Created: 2026-10-30
--
-- Слово владельца 30.10: «гид должен полностью управлять своей ролью из
-- MAX». Гид правит тексты своих туров в Word/Google-документах и до сих пор
-- отдавал их разработчику (миграция 1356). Теперь документ присылается в
-- личный диалог MAX: файл разбирается правилами (lib/docs/docx-text,
-- lib/guides/tour-edit/doc-sections), без модели, поле за полем; бот
-- показывает по каждому полю «было → станет» и кнопки «Сохранить всё» и
-- «Сохранить: <поле>». Без кнопки в тур не пишется ничего; запись — общей
-- функцией сайта (lib/tours/tour-write, writeTourPatch), как у правки фразой
-- (1357).
--
-- Строка — один документ:
--   · tour_id NULL — тур ещё выбирается кнопкой из candidate_ids;
--   · doc_values — поля, прошедшие проверку сайта (объект поле → значение);
--   · live_values — что было в этих полях, когда гид смотрел предпросмотр
--     (объект; NULL, пока тур не выбран). Кнопка сверяет поле с туром: его
--     поменяли после предпросмотра — поле не пишется, гид видит новое «было»;
--   · saved_fields — что уже записано («по одному»); все — status saved;
--   · один pending на чат; срок — expires_at (два часа).
-- Сам файл и его имя не хранятся. Персональных данных нет: текст тура.
--
-- Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS tour_doc_drafts (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id     UUID        NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  channel        TEXT        NOT NULL,
  chat_id        BIGINT      NOT NULL,
  tour_id        BIGINT      REFERENCES operator_tours(id) ON DELETE CASCADE,
  candidate_ids  BIGINT[]    NOT NULL DEFAULT '{}',
  doc_values     JSONB       NOT NULL,
  live_values    JSONB,
  saved_fields   TEXT[]      NOT NULL DEFAULT '{}',
  status         TEXT        NOT NULL DEFAULT 'pending',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  decided_at     TIMESTAMPTZ,
  CONSTRAINT tour_doc_drafts_channel_check CHECK (channel IN ('max', 'telegram')),
  CONSTRAINT tour_doc_drafts_values_check CHECK (jsonb_typeof(doc_values) = 'object' AND doc_values <> '{}'::jsonb),
  CONSTRAINT tour_doc_drafts_fields_check CHECK (
    doc_values ?| ARRAY['description', 'program', 'included', 'not_included', 'what_to_bring', 'safety_notes']
    AND NOT (doc_values ?| ARRAY['title', 'short_description', 'base_price'])),
  CONSTRAINT tour_doc_drafts_status_check CHECK (status IN ('pending', 'saved', 'cancelled', 'superseded')),
  CONSTRAINT tour_doc_drafts_decided_check CHECK ((decided_at IS NULL) = (status = 'pending')),
  CONSTRAINT tour_doc_drafts_live_check CHECK (tour_id IS NULL OR live_values IS NOT NULL),
  CONSTRAINT tour_doc_drafts_saved_tour_check CHECK (cardinality(saved_fields) = 0 OR tour_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS tour_doc_drafts_one_pending_per_chat
  ON tour_doc_drafts (channel, chat_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS tour_doc_drafts_partner_idx
  ON tour_doc_drafts (partner_id, created_at DESC);

COMMENT ON TABLE tour_doc_drafts IS
  'Документ гида (.docx) из MAX, разобранный по полям тура (1360): черновик до кнопки «Сохранить всё» / «Сохранить: поле». Сверка «было» по каждому полю; запись — lib/tours/tour-write.';

COMMIT;
