-- Migration 700: таблица для хранения фидбэка пользователей на ответы RAG-бота
CREATE TABLE IF NOT EXISTS rag_feedback (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id TEXT        NOT NULL,
  user_id    TEXT,
  query      TEXT,
  answer     TEXT,
  rating     INT         NOT NULL CHECK (rating IN (-1, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_rag_feedback_created_at ON rag_feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rag_feedback_user_id    ON rag_feedback(user_id) WHERE user_id IS NOT NULL;
