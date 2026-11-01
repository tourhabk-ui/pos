-- 1364: ответ «Другая дата» на входящую заявку из чата оператора.
-- Ответ человеку, не бронь и не оплата.

BEGIN;

ALTER TABLE partner_incoming_answers DROP CONSTRAINT IF EXISTS partner_incoming_answers_answer_check;
ALTER TABLE partner_incoming_answers ADD CONSTRAINT partner_incoming_answers_answer_check
  CHECK (answer IN ('accept', 'other_date', 'no_seats', 'clarify', 'self'));

COMMIT;

-- Rollback:
-- BEGIN;
-- DELETE FROM partner_incoming_answers WHERE answer = 'other_date';
-- ALTER TABLE partner_incoming_answers DROP CONSTRAINT IF EXISTS partner_incoming_answers_answer_check;
-- ALTER TABLE partner_incoming_answers ADD CONSTRAINT partner_incoming_answers_answer_check
--   CHECK (answer IN ('accept', 'no_seats', 'clarify', 'self'));
-- COMMIT;
