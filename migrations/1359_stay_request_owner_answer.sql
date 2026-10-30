-- Migration 1359: ответ хозяина жилья на заявку одной кнопкой (слово владельца 30.10)
-- Created: 2026-10-30
--
-- Владелец гостевого дома «Кутха» далёк от всего нового: заявку в MAX он
-- получал, но ответить мог только кнопкой «Ответить гостю» и набором текста,
-- а «когда занято» смотрел на бумажке. Под заявкой теперь три кнопки —
-- «Свободно, беру», «Занято», «Позвоню сам» (lib/stay/owner-answer): одно
-- нажатие, гостю уходит ответ словами хозяина, заявка перестаёт ждать.
--
-- Ответ записывается в саму заявку (stay_requests), один раз: второе нажатие
-- первое не переписывает (UPDATE … WHERE owner_answer IS NULL). Канал нажатия
-- — для ленты и разбора, не для прав: право даёт привязанный чат партнёра.
--
-- Напоминание через 2 часа без ответа (lib/crm/inbox-reminders) получает вид
-- `stay_request`; CHECK исходов напоминаний его узнаёт. Прежние значения
-- остаются: записанные исходы — история.

BEGIN;

ALTER TABLE stay_requests
  ADD COLUMN IF NOT EXISTS owner_answer     TEXT,
  ADD COLUMN IF NOT EXISTS owner_answered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS owner_answer_via TEXT;

ALTER TABLE stay_requests DROP CONSTRAINT IF EXISTS stay_requests_owner_answer_check;
ALTER TABLE stay_requests ADD CONSTRAINT stay_requests_owner_answer_check
  CHECK (owner_answer IS NULL OR owner_answer IN ('free', 'busy', 'call'));

ALTER TABLE stay_requests DROP CONSTRAINT IF EXISTS stay_requests_owner_answer_via_check;
ALTER TABLE stay_requests ADD CONSTRAINT stay_requests_owner_answer_via_check
  CHECK (owner_answer_via IS NULL OR owner_answer_via IN ('max', 'telegram', 'site'));

-- Ответ и его время — вместе: либо оба записаны, либо ни одного.
ALTER TABLE stay_requests DROP CONSTRAINT IF EXISTS stay_requests_owner_answer_pair;
ALTER TABLE stay_requests ADD CONSTRAINT stay_requests_owner_answer_pair
  CHECK ((owner_answer IS NULL) = (owner_answered_at IS NULL));

COMMENT ON COLUMN stay_requests.owner_answer IS 'Ответ хозяина кнопкой: free — свободно, беру; busy — занято; call — позвоню сам. NULL — ещё не отвечал кнопкой (ответом считается и сообщение в переписке).';
COMMENT ON COLUMN stay_requests.owner_answered_at IS 'Когда нажата кнопка ответа.';
COMMENT ON COLUMN stay_requests.owner_answer_via IS 'Откуда нажато: max, telegram, site.';

ALTER TABLE crm_inbox_reminders DROP CONSTRAINT IF EXISTS crm_inbox_reminders_kind_check;
ALTER TABLE crm_inbox_reminders ADD CONSTRAINT crm_inbox_reminders_kind_check CHECK (item_kind IN (
  'operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking', 'guide_invite',
  'charter_request', 'charter_ride', 'stay_request'
));

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE crm_inbox_reminders DROP CONSTRAINT IF EXISTS crm_inbox_reminders_kind_check;
-- ALTER TABLE crm_inbox_reminders ADD CONSTRAINT crm_inbox_reminders_kind_check CHECK (item_kind IN (
--   'operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking', 'guide_invite',
--   'charter_request', 'charter_ride'
-- ));
-- ALTER TABLE stay_requests DROP CONSTRAINT IF EXISTS stay_requests_owner_answer_pair;
-- ALTER TABLE stay_requests DROP CONSTRAINT IF EXISTS stay_requests_owner_answer_via_check;
-- ALTER TABLE stay_requests DROP CONSTRAINT IF EXISTS stay_requests_owner_answer_check;
-- ALTER TABLE stay_requests DROP COLUMN IF EXISTS owner_answer, DROP COLUMN IF EXISTS owner_answered_at, DROP COLUMN IF EXISTS owner_answer_via;
-- COMMIT;
