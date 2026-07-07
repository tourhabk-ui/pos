-- Migration 714: таблицы чата (сообщения турист <-> оператор)
--
-- Проблема: lib/services/chat.service.ts и /api/chat/* шлют SQL к таблицам
-- conversations / conversation_participants / conversation_messages, которых
-- НЕТ ни в одной миграции и ни в одном schema-файле — страница
-- /hub/tourist/messages и ChatWidget падали в 500 (если таблицы не заведены
-- на проде вручную).
--
-- Схема выведена из ФАКТИЧЕСКОГО кода (не выдумана):
--   - SQL-запросы chat.service.ts (INSERT/SELECT/UPDATE колонки,
--     ON CONFLICT (conversation_id, user_id))
--   - интерфейсы ConversationRow / ConversationParticipantRow /
--     ConversationMessageRow в lib/types/db-rows.ts:1312-1343
--
-- Идемпотентна: если таблицы заведены на проде вручную — не ломает.

BEGIN;

CREATE TABLE IF NOT EXISTS conversations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type       VARCHAR(20) NOT NULL DEFAULT 'direct' CHECK (type IN ('direct', 'group', 'support')),
  subject    TEXT,
  booking_id TEXT,
  tour_id    BIGINT,
  created_by UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            VARCHAR(32) NOT NULL DEFAULT 'tourist',
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_read_at    TIMESTAMPTZ,
  is_muted        BOOLEAN     NOT NULL DEFAULT false,
  consent_given   BOOLEAN     NOT NULL DEFAULT false,
  -- chat.service.createConversation: ON CONFLICT (conversation_id, user_id)
  UNIQUE (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content         TEXT        NOT NULL,
  message_type    VARCHAR(20) NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'system', 'image')),
  attachments     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  is_deleted      BOOLEAN     NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Горячие пути: список бесед юзера, участники беседы, сообщения по времени
CREATE INDEX IF NOT EXISTS idx_conv_participants_user ON conversation_participants (user_id);
CREATE INDEX IF NOT EXISTS idx_conv_participants_conv ON conversation_participants (conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_messages_conv_created ON conversation_messages (conversation_id, created_at);

COMMIT;
