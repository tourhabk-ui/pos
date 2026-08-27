-- 918: Volcano OS — автономные операции: awaiting_merge и конкурентная
-- идемпотентность (задание владельца 27.08, часть 1 и 3.1).
--
-- Два исправления correctness Kernel v1 (917) до снятия ручного approval:
--
-- 1. Состояние awaiting_merge — ТОЛЬКО для задач изменения кода/политики:
--    running → awaiting_merge → succeeded (PR merged) / rejected (closed) /
--    cancelled. Операционные задачи в него не переходят (сторож держит).
--
-- 2. Идемпотентность должна защищать ДО эффекта и под конкуренцией.
--    Индекс 917 (WHERE state='succeeded') позволял двум параллельным
--    вызовам одного ключа создать две queued/running задачи и оба
--    исполнить эффект. Теперь у внешнего ключа ровно один АКТИВНЫЙ или
--    успешный владелец; failed/cancelled/rejected не блокируют осознанный
--    новый retry.
--
-- Идемпотентность самой миграции: CHECK пересоздаётся через DROP IF EXISTS
-- + ADD; индексы — IF NOT EXISTS / DROP IF EXISTS. Повторный прогон — no-op.

-- ── 1. awaiting_merge в CHECK состояния ────────────────────────────────────
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_state_check;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_state_check CHECK (state IN (
  'proposed','awaiting_approval','queued','running','awaiting_merge',
  'succeeded','failed_retryable','failed_terminal','cancelled','rejected'));

-- ── 2. Один активный владелец у ключа идемпотентности ─────────────────────
-- Старый индекс (только succeeded) снимается; новый предикат покрывает все
-- состояния, в которых эффект ещё может исполниться или уже исполнен.
-- ON CONFLICT в kernel указывает этот же предикат — вставка конкурента
-- отбивается на уровне БД, не SELECT'ом до INSERT.
DROP INDEX IF EXISTS idx_agent_tasks_idempotency_succeeded;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_idempotency_active
  ON agent_tasks(idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND state IN ('proposed','awaiting_approval','queued','running','awaiting_merge','succeeded');

COMMENT ON INDEX idx_agent_tasks_idempotency_active IS
  'Volcano OS: у внешнего idempotency_key ровно один активный/успешный владелец; failed/cancelled/rejected не блокируют новый retry';
