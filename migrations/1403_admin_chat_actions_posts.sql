-- 1403: пост в канал из MAX администратора — фаза 2г.
-- Владелец 23.10 ответил «1a 2б» на вариант «б) следующим шагом — действия,
-- каждое с кнопкой подтверждения: открыть даты любого тура за оператора; пост
-- в канал; смена статуса заявки или брони»; 07.11 — «Just do it» по схеме
-- карточек подтверждения.
--
-- Та же таблица вопросов и журнала решений, что у отметки заявки (1400), дат
-- (1401) и брони за оператора (1402): живым в чате администратора остаётся
-- последний вопрос. Новое (производитель — lib/max/admin-post, этот же PR,
-- правило 10.09):
--   subject_kind 'post', action 'publish' — предмета в базе нет
--     (subject_id NULL), в params.text — ровно тот текст, что уйдёт в канал
--     после «Да». Публикует тот же единственный путь, что автоматические
--     посты (postToAllChannels): проверка текста и ссылок, Telegram, MAX.
-- ПД туриста здесь нет: в params — текст, который администратор сам
-- отправляет в открытый канал.
--
-- params.text проверяется через `?`, а не одним jsonb_typeof: у объекта без
-- ключа jsonb_typeof(params->'text') = NULL, и CHECK с NULL проходит молча.
--
-- Идемпотентна: DROP CONSTRAINT IF EXISTS перед ADD.

ALTER TABLE admin_chat_actions DROP CONSTRAINT IF EXISTS aca_subject_kind;
ALTER TABLE admin_chat_actions ADD CONSTRAINT aca_subject_kind CHECK (subject_kind IN ('lead', 'tour', 'booking', 'post'));

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
    WHEN 'post' THEN subject_id IS NULL
      AND params IS NOT NULL
      AND jsonb_typeof(params) = 'object'
      AND params ? 'text'
      AND jsonb_typeof(params->'text') = 'string'
      AND status <> 'draft'
    ELSE FALSE
  END
);

ALTER TABLE admin_chat_actions DROP CONSTRAINT IF EXISTS aca_action_of_subject;
ALTER TABLE admin_chat_actions ADD CONSTRAINT aca_action_of_subject CHECK (
  (subject_kind = 'lead' AND action IN ('contacted', 'converted', 'lost'))
  OR (subject_kind = 'tour' AND action = 'open_dates')
  OR (subject_kind = 'booking' AND action = 'confirm')
  OR (subject_kind = 'post' AND action = 'publish')
);
