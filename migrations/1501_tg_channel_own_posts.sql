-- Migration 1501: свои посты Telegram-канала, которые репостер не шлёт в MAX второй раз
-- Created: 2026-11-23
--
-- postToAllChannels и ручной пост с toMax уже публикуют тот же текст в MAX.
-- Репостер (app/api/bots/reposter/webhook) получает channel_post этих сообщений
-- и прислал бы дубль. Сюда пишется пара (числовой chat.id, message_id) сразу
-- после ответа Telegram и до отправки в MAX. У альбома — каждая message_id.
-- Ручной пост без toMax сюда не попадает: его репостер должен переслать.
--
-- В строке только числа, без текста поста.

BEGIN;

CREATE TABLE IF NOT EXISTS tg_channel_own_posts (
  tg_chat_id  BIGINT NOT NULL,
  message_id  BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tg_chat_id, message_id)
);

COMMENT ON TABLE tg_channel_own_posts IS
  'Посты, которые платформа сама отправила в Telegram и зеркалит в MAX. Репостер такие пары не пересылает.';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS tg_channel_own_posts;
-- COMMIT;
