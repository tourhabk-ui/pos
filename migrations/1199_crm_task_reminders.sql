-- Migration 1199: CRM фаза 1, шаг 1в-2 — напоминание о сроке задачи (#2325)
-- Created: 2026-10-09
--
-- Подошёл срок задачи — партнёру уходит одно напоминание в его канал
-- (`GET /api/cron/crm-reminders`, шаг cron-safety-heartbeat.yml). Колонки
-- заводятся вместе с писателем и читателем (правило 10.09):
--   * reminded_at — когда напоминание обработано; пишет крон, сбрасывает
--     перенос срока (updateTask), читает отбор крона (NULL — ещё не было);
--   * reminder_channel — чем кончилось, три исхода, а не два (§4.0):
--       max           — текст с задачами доставлен в MAX;
--       telegram_stub — MAX нет или отказал: в Telegram ушла заглушка без
--                       имён и заголовков («подошёл срок, откройте кабинет»);
--       unreachable   — у партнёра нет ни MAX, ни Telegram: слать некуда.
--     Отказ доставки (ни один канал не принял) НЕ записывается: строка
--     остаётся необработанной, и следующий прогон пробует снова. Читает
--     колонку экран задач — партнёр видит, дошло ли напоминание.

BEGIN;

ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;
ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS reminder_channel TEXT;

ALTER TABLE crm_tasks DROP CONSTRAINT IF EXISTS crm_tasks_reminder_channel_check;
ALTER TABLE crm_tasks ADD CONSTRAINT crm_tasks_reminder_channel_check
  CHECK (reminder_channel IS NULL OR reminder_channel IN ('max', 'telegram_stub', 'unreachable'));
-- Исход и момент пишутся парой: исход без момента — запись ниоткуда.
ALTER TABLE crm_tasks DROP CONSTRAINT IF EXISTS crm_tasks_reminder_pair;
ALTER TABLE crm_tasks ADD CONSTRAINT crm_tasks_reminder_pair
  CHECK ((reminded_at IS NULL) = (reminder_channel IS NULL));

COMMENT ON COLUMN crm_tasks.reminded_at IS 'Когда крон crm-reminders обработал напоминание о сроке. NULL — ещё не было; перенос срока сбрасывает.';
COMMENT ON COLUMN crm_tasks.reminder_channel IS 'Исход напоминания: max / telegram_stub (заглушка без ПД) / unreachable (каналов нет). Отказ доставки не пишется — повтор.';

-- Отбор крона: открытые, без напоминания, по сроку.
CREATE INDEX IF NOT EXISTS crm_tasks_remind_due_idx
  ON crm_tasks (due_at) WHERE done_at IS NULL AND reminded_at IS NULL;

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP INDEX IF EXISTS crm_tasks_remind_due_idx;
-- ALTER TABLE crm_tasks DROP CONSTRAINT IF EXISTS crm_tasks_reminder_pair;
-- ALTER TABLE crm_tasks DROP CONSTRAINT IF EXISTS crm_tasks_reminder_channel_check;
-- ALTER TABLE crm_tasks DROP COLUMN IF EXISTS reminder_channel;
-- ALTER TABLE crm_tasks DROP COLUMN IF EXISTS reminded_at;
-- COMMIT;
