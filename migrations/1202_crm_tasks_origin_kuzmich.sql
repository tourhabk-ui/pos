-- Migration 1202: CRM фаза 1, шаг 1д-1 — задачу может завести Кузьмич партнёра (#2325)
-- Created: 2026-10-10
--
-- Шаг 1д: у Кузьмича в чате партнёра (Telegram, MAX) появились инструменты
-- CRM — найти клиента, записать звонок, завести задачу, отметить её
-- выполненной (lib/crm/tools.ts). Задача, заведённая так, помечается
-- origin = 'kuzmich': на экране «Задачи» видно, что её завёл помощник по
-- просьбе партнёра, а не человек руками.
--
-- Колонка с производителем в том же PR (правило 10.09): писатель —
-- createTask(..., { origin: 'kuzmich' }) из инструмента crm_add_task.
-- 'mcp' НЕ добавляется: MCP партнёра — шаг 1д-2, и значение придёт своей
-- миграцией вместе с роутом, который его пишет.

BEGIN;

ALTER TABLE crm_tasks DROP CONSTRAINT IF EXISTS crm_tasks_origin_check;
ALTER TABLE crm_tasks ADD CONSTRAINT crm_tasks_origin_check CHECK (origin IN ('manual', 'kuzmich'));

COMMENT ON COLUMN crm_tasks.origin IS
  'Кто завёл: manual — человек в кабинете; kuzmich — Кузьмич в чате партнёра по его просьбе (1д-1). mcp — шаг 1д-2.';

COMMIT;

-- Rollback:
-- BEGIN;
-- UPDATE crm_tasks SET origin = 'manual' WHERE origin = 'kuzmich';
-- ALTER TABLE crm_tasks DROP CONSTRAINT IF EXISTS crm_tasks_origin_check;
-- ALTER TABLE crm_tasks ADD CONSTRAINT crm_tasks_origin_check CHECK (origin IN ('manual'));
-- COMMIT;
