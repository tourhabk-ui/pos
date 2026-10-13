-- Migration 1231: исход напоминания о задаче «ушло менеджерам команды» (CRM 2г-5)
-- Created: 2026-10-13
--
-- Решение владельца 13.10: «напоминания о задачах тоже менеджерам». Копию
-- напоминания получают менеджеры команды оператора со своим мессенджером
-- (lib/crm/reminders.ts → lib/operators/team-notify.ts).
--
-- У кабинета без своего канала напоминание до сих пор записывалось как
-- `unreachable` («не отправлено: не подключён ни MAX, ни Telegram»). Теперь
-- его могут получить менеджеры, и прежнее слово на экране задач стало бы
-- неправдой. Поэтому исходов четыре:
--   max           — текст с задачами доставлен в MAX кабинета;
--   telegram_stub — в Telegram кабинета ушла заглушка без имён и заголовков;
--   team          — у кабинета канала нет, напоминание дошло до менеджеров;
--   unreachable   — слать некуда никому.
-- Пишет крон crm-reminders, читает экран задач (components/crm/TaskList.tsx).
-- Существующие строки новому условию удовлетворяют: значение `team` новое.

BEGIN;

ALTER TABLE crm_tasks DROP CONSTRAINT IF EXISTS crm_tasks_reminder_channel_check;
ALTER TABLE crm_tasks ADD CONSTRAINT crm_tasks_reminder_channel_check
  CHECK (reminder_channel IS NULL OR reminder_channel IN ('max', 'telegram_stub', 'team', 'unreachable'));

COMMENT ON COLUMN crm_tasks.reminder_channel IS 'Исход напоминания: max / telegram_stub (заглушка без ПД) / team (у кабинета канала нет — дошло до менеджеров команды) / unreachable (слать некуда). Отказ доставки не пишется — повтор.';

COMMIT;

-- Rollback:
-- BEGIN;
-- UPDATE crm_tasks SET reminder_channel = 'unreachable' WHERE reminder_channel = 'team';
-- ALTER TABLE crm_tasks DROP CONSTRAINT IF EXISTS crm_tasks_reminder_channel_check;
-- ALTER TABLE crm_tasks ADD CONSTRAINT crm_tasks_reminder_channel_check
--   CHECK (reminder_channel IS NULL OR reminder_channel IN ('max', 'telegram_stub', 'unreachable'));
-- COMMIT;
