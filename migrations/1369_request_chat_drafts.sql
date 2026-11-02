-- 1369: ответ клиенту по заявке — предпросмотр и «Отправить», и из Telegram
-- (план CRM в мессенджере, п. 2; решение владельца: отвечать туристу из TG
-- можно, с маской ПД).
--
-- request_chat_waits: канал 'telegram' (только сторона адресата — проверяет
-- код), статус 'draft' и текст черновика. Черновик — то же ожидание: после
-- текста адресата оно становится 'draft', «Отправить» переводит в 'used'
-- одним UPDATE (повтор нажатия ничего не шлёт), «Отменить» — в 'cancelled'.
-- request_messages: door 'telegram'.
-- Идемпотентна.

BEGIN;

ALTER TABLE request_chat_waits ADD COLUMN IF NOT EXISTS draft_text TEXT;

ALTER TABLE request_chat_waits DROP CONSTRAINT IF EXISTS stay_chat_waits_channel_check;
ALTER TABLE request_chat_waits DROP CONSTRAINT IF EXISTS request_chat_waits_channel_check;
ALTER TABLE request_chat_waits ADD CONSTRAINT request_chat_waits_channel_check
  CHECK (channel IN ('max', 'telegram'));

ALTER TABLE request_chat_waits DROP CONSTRAINT IF EXISTS stay_chat_waits_status_check;
ALTER TABLE request_chat_waits DROP CONSTRAINT IF EXISTS request_chat_waits_status_check;
ALTER TABLE request_chat_waits ADD CONSTRAINT request_chat_waits_status_check
  CHECK (status IN ('waiting', 'draft', 'used', 'cancelled', 'superseded'));

ALTER TABLE request_chat_waits DROP CONSTRAINT IF EXISTS request_chat_waits_draft_check;
ALTER TABLE request_chat_waits ADD CONSTRAINT request_chat_waits_draft_check
  CHECK (status <> 'draft' OR draft_text IS NOT NULL);

ALTER TABLE request_messages DROP CONSTRAINT IF EXISTS stay_request_messages_door_check;
ALTER TABLE request_messages DROP CONSTRAINT IF EXISTS request_messages_door_check;
ALTER TABLE request_messages ADD CONSTRAINT request_messages_door_check
  CHECK (door IN ('max', 'page', 'telegram'));

COMMIT;
