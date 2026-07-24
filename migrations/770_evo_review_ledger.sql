-- Леджер покрытия ревью эволюции: чтобы Growth Scan систематически прочёсывал
-- всю платформу (622 роута / 329 модулей), а не перечитывал 2 ядровых файла.
-- Каждый прогон помнит, что уже смотрел, и берёт следующие невиданные/давно-
-- невиданные файлы по приоритету риска.
CREATE TABLE IF NOT EXISTS evo_review_ledger (
  file_path        TEXT PRIMARY KEY,
  last_reviewed_at TIMESTAMPTZ,
  review_count     INT DEFAULT 0,
  last_findings    INT DEFAULT 0,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evo_review_ledger_last
  ON evo_review_ledger (last_reviewed_at NULLS FIRST);
