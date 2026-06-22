-- Migration 695: RAG quality evaluation log
-- Stores LLM-judge scores for RAG answer quality (relevance + completeness)

CREATE TABLE IF NOT EXISTS rag_quality_log (
  id                 BIGSERIAL    PRIMARY KEY,
  query              TEXT         NOT NULL,
  answer             TEXT         NOT NULL,
  relevance_score    SMALLINT     CHECK (relevance_score BETWEEN 1 AND 5),
  completeness_score SMALLINT     CHECK (completeness_score BETWEEN 1 AND 5),
  verdict            TEXT,
  model              TEXT,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_quality_created ON rag_quality_log(created_at DESC);
