-- 1371: ответ туристу в обычном чате Ведара (conversations) из мессенджера
-- партнёра — «Ответить» → текст → предпросмотр → «Отправить» (план CRM в
-- мессенджере, п.2; владелец: «отвечать туристу из TG можно, с маской ПД»).
-- Ожидание и черновик — одна строка, как request_chat_waits (1349/1369):
-- waiting → draft (текст) → used одним UPDATE (повтор нажатия ничего не шлёт)
-- или cancelled/superseded. Одно живое ожидание на чат канала.
-- Идемпотентна.

BEGIN;

CREATE TABLE IF NOT EXISTS conversation_reply_waits (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel          TEXT NOT NULL CHECK (channel IN ('max', 'telegram')),
  chat_id          BIGINT NOT NULL,
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  partner_id       UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  sender_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'waiting'
                   CHECK (status IN ('waiting', 'draft', 'used', 'cancelled', 'superseded')),
  draft_text       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  used_at          TIMESTAMPTZ,
  CONSTRAINT conversation_reply_waits_draft_check CHECK (status <> 'draft' OR draft_text IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_reply_waits_one_live
  ON conversation_reply_waits (channel, chat_id) WHERE status IN ('waiting', 'draft');
CREATE INDEX IF NOT EXISTS conversation_reply_waits_conversation
  ON conversation_reply_waits (conversation_id);

COMMIT;
