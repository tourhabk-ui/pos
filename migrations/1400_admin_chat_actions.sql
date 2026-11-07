-- 1400: действия администратора из MAX с кнопкой подтверждения — фаза 2
-- (фаза 1 — чтение, 1324; владелец 23.10: «действия с кнопкой — следующим
-- шагом», 07.11: «Just do it» по схеме карточек подтверждения).
--
-- Администратор в личном чате MAX открывает заявку из списка «Заявки»,
-- выбирает «Связался», «Договорились» или «Отказ», и бот спрашивает
-- «Отметить …?» — [Да] [Не надо]. До «Да» заявка не меняется. Между вопросом
-- и нажатием вопрос живёт здесь; кнопка несёт только id строки, а право
-- нажатия даёт администратор, привязанный к MAX и владеющий ролью СЕЙЧАС, и
-- чат, где задан вопрос (lib/max/admin-actions).
--
-- Строка — и вопрос, и журнал решения: кто (admin_user_id), где (chat_id),
-- что (subject_kind, subject_id, action), когда (created_at, used_at), итог
-- (outcome). Текста заявки, имени и телефона туриста здесь нет.
--
-- Статусы и их производители (все в этом же PR, правило 10.09):
--   ready      — вопрос задан, ждёт «Да» или «Не надо»;
--   running    — «Да» нажато, правило статуса заявки выполняется;
--   done       — выполнено, исход (сменился ли статус) — в outcome;
--   refused    — «Да» нажато, а заявки уже нет: ничего не записано, причина в outcome;
--   cancelled  — нажато «Не надо»;
--   superseded — в том же чате задан новый вопрос: живым остаётся последний.
-- «Истекло» — не статус, а вычисление expires_at <= NOW(): просроченный
-- вопрос не исполняется и новым вопросом сам не становится.
--
-- Идемпотентна: IF NOT EXISTS у таблицы и индексов.

CREATE TABLE IF NOT EXISTS admin_chat_actions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel       VARCHAR(16) NOT NULL DEFAULT 'max' CHECK (channel IN ('max')),
  chat_id       BIGINT NOT NULL,
  subject_kind  VARCHAR(16) NOT NULL CHECK (subject_kind IN ('lead')),
  subject_id    TEXT NOT NULL,
  action        VARCHAR(16) NOT NULL,
  status        VARCHAR(16) NOT NULL
                CHECK (status IN ('ready', 'running', 'done', 'refused', 'cancelled', 'superseded')),
  outcome       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  CONSTRAINT aca_subject_form CHECK (
    subject_kind = 'lead'
    AND subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  CONSTRAINT aca_action_of_subject CHECK (
    subject_kind = 'lead' AND action IN ('contacted', 'converted', 'lost')
  ),
  CONSTRAINT aca_used_when_pressed CHECK ((used_at IS NOT NULL) = (status IN ('running', 'done', 'refused'))),
  CONSTRAINT aca_outcome_final CHECK ((outcome IS NOT NULL) = (status IN ('done', 'refused')))
);

-- Живой вопрос чата снимается новым: поиск ready по чату администратора.
CREATE INDEX IF NOT EXISTS idx_admin_chat_actions_live
  ON admin_chat_actions (admin_user_id, chat_id) WHERE status = 'ready';

-- Журнал решений по времени — для админки и переписи.
CREATE INDEX IF NOT EXISTS idx_admin_chat_actions_created
  ON admin_chat_actions (created_at DESC);
