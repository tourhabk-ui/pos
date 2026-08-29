-- 920: Volcano OS — атомарный дедуп задачи code.merge по ресурсу.
--
-- Аудит ядра 28.08 нашёл, что `ensureCodeMergeTask` дедуплицировал задачу PR
-- ТОЛЬКО через SELECT (`findActiveCodeMergeTask`) ДО INSERT — check-then-act
-- с окном гонки ровно там, где `opened` и `synchronize` одного PR могут
-- прийти почти одновременно (два webhook-события GitHub, повторная
-- доставка), тем же классом гонки, что уже закрывался у `evo.run`.
--
-- Общий `idempotency_key` (индекс 918, `idx_agent_tasks_idempotency_active`)
-- сюда не подходит: тот держит ключ занятым и после `succeeded` — верно для
-- одноразового внешнего эффекта, но у `code.merge` `succeeded` значит
-- «PR смержен», и reopened-PR после этого обязан получить НОВУЮ задачу
-- (уже проверено интеграционным тестом `agent-kernel.pg.test.ts`). Нужен
-- свой предикат: занято, только пока задача НЕ терминальна.

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_active_resource
  ON agent_tasks(capability, resource_type, resource_id)
  WHERE resource_type IS NOT NULL AND resource_id IS NOT NULL
    AND state NOT IN ('succeeded','failed_terminal','cancelled','rejected');

COMMENT ON INDEX idx_agent_tasks_active_resource IS
  'Volcano OS: атомарный дедуп задачи по (capability,resource) пока задача НЕ терминальна — reopened/новый цикл после терминала получает новую задачу';

-- ── recordPrEventOnce: тот же класс check-then-act, другая таблица ────────
--
-- Дедуп события PR (event_type + head_sha + kind) шёл SELECT ДО INSERT без
-- уникального индекса под ним — тот же класс гонки, что у задачи выше, но
-- в agent_events. agent_events append-only ТОЛЬКО в смысле запрета
-- UPDATE/DELETE (триггер миграции 917) — уникальность внутри INSERT это не
-- ограничивает.
--
-- Предикат `details ? 'head_sha'` (JSONB-оператор «есть такой ключ») сужает
-- индекс ровно до событий, прошедших через `recordPrEventOnce` (там
-- `head_sha` — обязательное поле фингерпринта). Без этого сужения индекс
-- задел бы и не связанные с PR `note`-события на том же task_id без
-- head_sha вовсе (например `telegram_failed` в `merge-gate.ts`, пишется
-- напрямую через `appendEvent`, не через `recordPrEventOnce`) — два таких
-- события были бы неотличимы друг от друга по (task_id, 'note', NULL, '') и
-- второе тихо потерялось бы, хотя оба легитимны и независимы.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_events_pr_dedup
  ON agent_events (task_id, event_type, (details->>'head_sha'), (COALESCE(details->>'kind', '')))
  WHERE details ? 'head_sha';

COMMENT ON INDEX idx_agent_events_pr_dedup IS
  'Volcano OS: атомарный дедуп PR-событий (task_id, event_type, head_sha, kind) для recordPrEventOnce — сужен ключом head_sha в details, чтобы не задевать несвязанные note-события без него';
