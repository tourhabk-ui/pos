-- 1367: «Отказать» на входящую заявку из чата оператора (план CRM в
-- мессенджерах, PR2; решение владельца 02.11: отказ — отдельный статус с
-- причиной, короткие кнопки причин и необязательный текст).
--
-- Ответ человеку, не бронь и не оплата. Причина — код кнопки; текст —
-- необязательный комментарий оператора (пишется позже, отдельно).

BEGIN;

ALTER TABLE partner_incoming_answers ADD COLUMN IF NOT EXISTS decline_reason TEXT;
ALTER TABLE partner_incoming_answers ADD COLUMN IF NOT EXISTS decline_note TEXT;

ALTER TABLE partner_incoming_answers DROP CONSTRAINT IF EXISTS partner_incoming_answers_answer_check;
ALTER TABLE partner_incoming_answers ADD CONSTRAINT partner_incoming_answers_answer_check
  CHECK (answer IN ('accept', 'other_date', 'no_seats', 'clarify', 'self', 'decline'));

ALTER TABLE partner_incoming_answers DROP CONSTRAINT IF EXISTS partner_incoming_answers_decline_check;
ALTER TABLE partner_incoming_answers ADD CONSTRAINT partner_incoming_answers_decline_check
  CHECK (
    (answer = 'decline' AND decline_reason IN ('seats', 'weather', 'dates', 'group', 'other'))
    OR (answer <> 'decline' AND decline_reason IS NULL AND decline_note IS NULL)
  );

ALTER TABLE partner_incoming_answers DROP CONSTRAINT IF EXISTS partner_incoming_answers_note_len;
ALTER TABLE partner_incoming_answers ADD CONSTRAINT partner_incoming_answers_note_len
  CHECK (decline_note IS NULL OR char_length(decline_note) <= 500);

COMMIT;

-- Rollback:
-- BEGIN;
-- DELETE FROM partner_incoming_answers WHERE answer = 'decline';
-- ALTER TABLE partner_incoming_answers DROP CONSTRAINT IF EXISTS partner_incoming_answers_note_len;
-- ALTER TABLE partner_incoming_answers DROP CONSTRAINT IF EXISTS partner_incoming_answers_decline_check;
-- ALTER TABLE partner_incoming_answers DROP CONSTRAINT IF EXISTS partner_incoming_answers_answer_check;
-- ALTER TABLE partner_incoming_answers ADD CONSTRAINT partner_incoming_answers_answer_check
--   CHECK (answer IN ('accept', 'other_date', 'no_seats', 'clarify', 'self'));
-- ALTER TABLE partner_incoming_answers DROP COLUMN IF EXISTS decline_note;
-- ALTER TABLE partner_incoming_answers DROP COLUMN IF EXISTS decline_reason;
-- COMMIT;
