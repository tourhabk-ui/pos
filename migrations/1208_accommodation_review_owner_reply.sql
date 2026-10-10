-- Migration 1208: ответ владельца жилья на отзыв гостя (CRM, хвосты фазы 1, #2325)
-- Created: 2026-10-10
--
-- Во «Входящих» владельца жилья отзыв числился «ответа на платформе нет»:
-- у accommodation_reviews (миграция 716) не было колонок ответа, а у
-- владельца — ни экрана, ни роута. Теперь ответ пишет владелец из кабинета
-- (/hub/stay/reviews, POST /api/stay/reviews/[id]/reply), гость видит его под
-- отзывом на странице объекта.
--
-- Колонки с производителем и потребителем в том же PR (10.10 → правило 10.09):
--   * owner_reply — текст ответа; писатель — роут ответа, читатели —
--     страница объекта, экран владельца, «Входящие»;
--   * owner_reply_at — когда ответил; по нему «Входящие» считают ответ.
-- Пара держится CHECK: ответ без времени (и наоборот) не записать.

BEGIN;

ALTER TABLE accommodation_reviews ADD COLUMN IF NOT EXISTS owner_reply TEXT;
ALTER TABLE accommodation_reviews ADD COLUMN IF NOT EXISTS owner_reply_at TIMESTAMPTZ;

ALTER TABLE accommodation_reviews DROP CONSTRAINT IF EXISTS accommodation_reviews_owner_reply_len;
ALTER TABLE accommodation_reviews ADD CONSTRAINT accommodation_reviews_owner_reply_len
  CHECK (owner_reply IS NULL OR char_length(owner_reply) BETWEEN 1 AND 2000);
ALTER TABLE accommodation_reviews DROP CONSTRAINT IF EXISTS accommodation_reviews_owner_reply_pair;
ALTER TABLE accommodation_reviews ADD CONSTRAINT accommodation_reviews_owner_reply_pair
  CHECK ((owner_reply IS NULL) = (owner_reply_at IS NULL));

COMMENT ON COLUMN accommodation_reviews.owner_reply IS 'Ответ владельца на отзыв (1208); виден гостям под отзывом.';
COMMENT ON COLUMN accommodation_reviews.owner_reply_at IS 'Когда владелец ответил; NULL — не отвечал.';

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE accommodation_reviews DROP CONSTRAINT IF EXISTS accommodation_reviews_owner_reply_pair;
-- ALTER TABLE accommodation_reviews DROP CONSTRAINT IF EXISTS accommodation_reviews_owner_reply_len;
-- ALTER TABLE accommodation_reviews DROP COLUMN IF EXISTS owner_reply_at;
-- ALTER TABLE accommodation_reviews DROP COLUMN IF EXISTS owner_reply;
-- COMMIT;
