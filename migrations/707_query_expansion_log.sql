-- 707_query_expansion_log.sql
-- Логирование эффекта multi-query RAG-расширения searchRoutes (issue #250):
-- сколько вариантов запроса генерируется и добавляет ли расширение новые
-- маршруты поверх базового запроса — данные для решения оставлять/откатывать
-- RAG_MULTIQUERY (сейчас выключен по умолчанию, см. lib/ai/query-expansion.ts).

CREATE TABLE IF NOT EXISTS query_expansion_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orig_query     TEXT NOT NULL,
  expanded_count INT NOT NULL,   -- сколько вариантов сгенерировано (без оригинала)
  unique_added   INT NOT NULL,   -- сколько маршрутов попало в выдачу ТОЛЬКО из расширенных вариантов
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_query_expansion_log_created_at ON query_expansion_log(created_at);
