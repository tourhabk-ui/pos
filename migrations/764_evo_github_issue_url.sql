-- 764: рука эволюции заводит GitHub Issues из находок Growth Scan.
--
-- Первый оборот петли «заметил → сформулировал задачу → разместил её в мире»
-- без человека посередине. Находки в статусе 'suggested' (Evolution Loop не
-- смог свести к детерминированной правке — нужен человек) раннер выносит в
-- GitHub Issues. Колонка помечает уже вынесенное, чтобы не плодить дубли.
--
-- Идемпотентно (ADD COLUMN IF NOT EXISTS).

ALTER TABLE evo_growth_issues
  ADD COLUMN IF NOT EXISTS github_issue_url TEXT;

-- Быстрый отбор «что ещё не вынесено»: suggested без ссылки на issue.
CREATE INDEX IF NOT EXISTS idx_evo_growth_issues_reportable
  ON evo_growth_issues (status)
  WHERE github_issue_url IS NULL;
