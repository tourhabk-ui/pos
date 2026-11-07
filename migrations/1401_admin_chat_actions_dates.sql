-- 1401: даты за оператора из MAX администратора — фаза 2б. Слово владельца
-- 07.11: «да» на «начать с дат за оператора: оператор говорит вам «12.11 есть
-- 6 мест», вы открываете дату в MAX, оператору приходит сообщение, что дату
-- открыли вы».
--
-- Та же таблица вопросов и журнала решений, что у отметки заявки (1400):
-- живым в чате администратора остаётся последний вопрос, какого бы рода он
-- ни был. Новое (производитель всего — lib/max/admin-dates, этот же PR,
-- правило 10.09):
--   subject_kind 'tour', action 'open_dates' — предмет: тур
--     (operator_tours.id), что открыть — в params: оператор (partners.id),
--     даты и места. Записывает даты та же функция, что у кабинета и чата
--     оператора (openTourDatesTx);
--   status 'draft' — фраза подошла к нескольким турам, вопрос ждёт выбора
--     тура кнопкой: тура ещё нет (subject_id NULL), кандидаты — в params;
--   params JSONB — только у дат; у заявки его нет.
-- ПД туриста здесь нет и не появляется: тур, оператор, даты, число мест.
--
-- Ограничения переписаны явными CASE: subject_id стал необязательным, а
-- проверка с NULL в CHECK проходит молча — «subject_id ~ …» без IS NOT NULL
-- пропустила бы заявку без предмета.
--
-- Идемпотентна: ADD COLUMN IF NOT EXISTS, DROP … IF EXISTS перед ADD.

ALTER TABLE admin_chat_actions ADD COLUMN IF NOT EXISTS params JSONB;
ALTER TABLE admin_chat_actions ALTER COLUMN subject_id DROP NOT NULL;

ALTER TABLE admin_chat_actions DROP CONSTRAINT IF EXISTS admin_chat_actions_subject_kind_check;
ALTER TABLE admin_chat_actions DROP CONSTRAINT IF EXISTS aca_subject_kind;
ALTER TABLE admin_chat_actions ADD CONSTRAINT aca_subject_kind CHECK (subject_kind IN ('lead', 'tour'));

ALTER TABLE admin_chat_actions DROP CONSTRAINT IF EXISTS admin_chat_actions_status_check;
ALTER TABLE admin_chat_actions DROP CONSTRAINT IF EXISTS aca_status;
ALTER TABLE admin_chat_actions ADD CONSTRAINT aca_status
  CHECK (status IN ('draft', 'ready', 'running', 'done', 'refused', 'cancelled', 'superseded'));

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
    ELSE FALSE
  END
);

ALTER TABLE admin_chat_actions DROP CONSTRAINT IF EXISTS aca_action_of_subject;
ALTER TABLE admin_chat_actions ADD CONSTRAINT aca_action_of_subject CHECK (
  (subject_kind = 'lead' AND action IN ('contacted', 'converted', 'lost'))
  OR (subject_kind = 'tour' AND action = 'open_dates')
);

-- Живой вопрос чата — и готовый, и ждущий выбора тура: новый снимает оба.
DROP INDEX IF EXISTS idx_admin_chat_actions_live;
CREATE INDEX IF NOT EXISTS idx_admin_chat_actions_live
  ON admin_chat_actions (admin_user_id, chat_id) WHERE status IN ('draft', 'ready');
