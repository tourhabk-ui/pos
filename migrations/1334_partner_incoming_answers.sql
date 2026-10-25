-- 1334: ответ партнёра на входящую заявку из чата.
--
-- Кнопки «Принять / Нет мест / Уточнить / Свяжусь сам». Одна строка на
-- предмет: второе нажатие не переписывает первое. Это ответ человеку,
-- не подтверждение брони и не оплата.
--
-- Та же таблица, что в запросе карточки входящих: CREATE IF NOT EXISTS,
-- чтобы два запроса не завели её дважды.

BEGIN;

CREATE TABLE IF NOT EXISTS partner_incoming_answers (
  id BIGSERIAL PRIMARY KEY,
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT partner_incoming_answers_kind_check
    CHECK (subject_kind IN ('lead', 'stay_request', 'stay_booking', 'gear', 'booking')),
  CONSTRAINT partner_incoming_answers_answer_check
    CHECK (answer IN ('accept', 'no_seats', 'clarify', 'self')),
  CONSTRAINT partner_incoming_answers_subject_uidx UNIQUE (subject_kind, subject_id)
);

COMMENT ON TABLE partner_incoming_answers IS
  'Ответ партнёра кнопкой в чате. Не подтверждает бронь и не принимает оплату.';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS partner_incoming_answers;
-- COMMIT;
