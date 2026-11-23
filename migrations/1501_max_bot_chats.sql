-- 1501_max_bot_chats.sql
--
-- GET /chats снят в MAX в июне 2026, метод getAllChats убран из
-- @maxhub/max-bot-api 1.0. Документация (dev.max.ru, «Получение ID чата
-- или канала»): chat_id приходит в Update, его надо хранить и удалять
-- на bot_removed. Таблица — это хранилище.
--
-- Заполняем тем, что уже лежит в базе: чаты партнёра, менеджера и
-- сотрудника. Тип и название не выдумываем — их принесёт событие.
-- Личные chat_id гостей (leads.guest_max_chat_id, stay_requests) не
-- копируем: это идентификаторы туристов, а список читает админ для
-- сопоставления каналов.
-- MAX_CHANNEL_ID и REPOSTER_ROUTES здесь нет: они в окружении, не в SQL.
-- Повтор безопасен (ON CONFLICT DO NOTHING).

BEGIN;

CREATE TABLE IF NOT EXISTS max_bot_chats (
  chat_id BIGINT PRIMARY KEY,
  chat_type TEXT NULL,
  title TEXT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT max_bot_chats_chat_type_check
    CHECK (chat_type IS NULL OR chat_type IN ('dialog', 'chat', 'channel'))
);

COMMENT ON TABLE max_bot_chats IS
  'Чаты, в которых бот MAX видел себя. Источник — входящие Update (bot_added, bot_started, message_created, message_callback, chat_title_changed) и уже записанные chat_id партнёров. Удаление — bot_removed. Имени человека здесь нет.';

COMMENT ON COLUMN max_bot_chats.chat_type IS
  'dialog | chat | channel, как в объекте Chat MAX. NULL — событие тип не назвало.';

COMMENT ON COLUMN max_bot_chats.title IS
  'Название чата или канала из chat_title_changed. NULL — названия ещё не было. Для диалога документация допускает null.';

INSERT INTO max_bot_chats (chat_id)
SELECT DISTINCT max_chat_id FROM partners WHERE max_chat_id IS NOT NULL
ON CONFLICT (chat_id) DO NOTHING;

INSERT INTO max_bot_chats (chat_id)
SELECT DISTINCT max_chat_id FROM operator_members WHERE max_chat_id IS NOT NULL
ON CONFLICT (chat_id) DO NOTHING;

INSERT INTO max_bot_chats (chat_id)
SELECT DISTINCT max_chat_id FROM operator_staff WHERE max_chat_id IS NOT NULL
ON CONFLICT (chat_id) DO NOTHING;

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS max_bot_chats;
-- COMMIT;
