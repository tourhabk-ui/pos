-- 1402: подтверждение брони за оператора из MAX администратора — фаза 2в.
-- Слово владельца 07.11: «да» на «бронь ждёт ответа оператора, вы ему
-- позвонили и жмёте «Оператор подтвердил». Турист получит обычное
-- подтверждение. Риск больше: когда оплату снова включат, после
-- подтверждения турист сможет платить».
--
-- Та же таблица вопросов и журнала решений, что у отметки заявки (1400) и дат
-- за оператора (1401): живым в чате администратора остаётся последний
-- вопрос. Новое (производитель — lib/max/admin-bookings, этот же PR,
-- правило 10.09):
--   subject_kind 'booking', action 'confirm' — предмет: бронь
--     (operator_bookings.id), в params — оператор тура и вывеска на момент
--     вопроса, тур, день и число людей (для итога и журнала). Пишет статус
--     та же функция, что у кабинета оператора и его чата
--     (changeOwnerBookingStatus): владение по туру, переход new → confirmed,
--     письмо и уведомления туристу.
-- ПД туриста здесь нет: ни имени, ни телефона, ни почты.
--
-- Идемпотентна: DROP CONSTRAINT IF EXISTS перед ADD.

ALTER TABLE admin_chat_actions DROP CONSTRAINT IF EXISTS aca_subject_kind;
ALTER TABLE admin_chat_actions ADD CONSTRAINT aca_subject_kind CHECK (subject_kind IN ('lead', 'tour', 'booking'));

ALTER TABLE admin_chat_actions DROP CONSTRAINT IF EXISTS aca_subject_form;
ALTER TABLE admin_chat_actions ADD CONSTRAINT aca_subject_form CHECK (
  CASE subject_kind
    WHEN 'lead' THEN subject_id IS NOT NULL
      AND subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND params IS NULL
      AND status <> 'draft'
    WHEN 'tour' THEN params IS NOT NULL
      AND jsonb_typeof(params) = 'object'
      AND (
        (subject_id IS NOT NULL AND subject_id ~ '^[1-9][0-9]{0,18}$')
        OR (subject_id IS NULL AND status IN ('draft', 'superseded', 'cancelled'))
      )
    WHEN 'booking' THEN subject_id IS NOT NULL
      AND subject_id ~ '^[1-9][0-9]{0,18}$'
      AND params IS NOT NULL
      AND jsonb_typeof(params) = 'object'
      AND status <> 'draft'
    ELSE FALSE
  END
);

ALTER TABLE admin_chat_actions DROP CONSTRAINT IF EXISTS aca_action_of_subject;
ALTER TABLE admin_chat_actions ADD CONSTRAINT aca_action_of_subject CHECK (
  (subject_kind = 'lead' AND action IN ('contacted', 'converted', 'lost'))
  OR (subject_kind = 'tour' AND action = 'open_dates')
  OR (subject_kind = 'booking' AND action = 'confirm')
);
