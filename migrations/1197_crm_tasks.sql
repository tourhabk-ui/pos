-- Migration 1197: CRM фаза 1, шаг 1в — задачи партнёра по клиенту (#2325)
-- Created: 2026-10-09
--
-- Решение владельца 09.10 («Хорошо реализуем»): у клиента партнёра есть
-- дела — «перезвонить завтра», «уточнить состав группы», «следующий
-- контакт». Задача принадлежит партнёру; клиент у неё может быть, а может
-- и не быть (общее дело кабинета).
--
-- Колонки — только с производителем в этом же PR (правило 10.09):
--   * origin = 'manual' — задачу завёл человек в кабинете. Кузьмич и MCP
--     партнёра (шаг 1д) расширят CHECK своей миграцией вместе с кодом;
--   * reminded_at появится с кроном напоминаний (шаг 1в-2), а не раньше:
--     колонка без писателя читалась бы как «напоминаний не было никогда»;
--   * источник (бронь, заявка) у задачи не заводится — создавать её
--     с экрана брони пока негде.
--
-- Клиент удалён — его задачи удаляются вместе с ним: дело о человеке,
-- которого больше нет у партнёра, не нужно, а текст задачи может называть
-- его (удаление по 152-ФЗ, #2327). Лента (crm_events) так не делает — она
-- журнал, и событие «задача выполнена» остаётся у партнёра без клиента.
--
-- Выполнение задачи с клиентом пишет в ленту событие task_done — вид
-- добавляется в CHECK crm_events ниже.

BEGIN;

CREATE TABLE IF NOT EXISTS crm_tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id  UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  contact_id  UUID REFERENCES crm_contacts(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  details     TEXT,
  due_at      TIMESTAMPTZ NOT NULL,
  done_at     TIMESTAMPTZ,
  done_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  origin      TEXT NOT NULL DEFAULT 'manual',
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_tasks_origin_check CHECK (origin IN ('manual')),
  CONSTRAINT crm_tasks_title_len CHECK (char_length(title) BETWEEN 1 AND 300),
  CONSTRAINT crm_tasks_details_len CHECK (details IS NULL OR char_length(details) <= 5000),
  -- Выполнена — значит известно когда; «кем» может стереться с аккаунтом.
  CONSTRAINT crm_tasks_done_pair CHECK (done_by IS NULL OR done_at IS NOT NULL)
);

COMMENT ON TABLE crm_tasks IS 'Задачи партнёра по клиенту (CRM фаза 1, шаг 1в, #2325). Удаляются вместе с клиентом.';
COMMENT ON COLUMN crm_tasks.contact_id IS 'NULL — общее дело кабинета, без клиента.';
COMMENT ON COLUMN crm_tasks.origin IS 'Кто завёл: manual — человек в кабинете. kuzmich и mcp — шаг 1д, вместе с производителями.';

-- Открытые задачи партнёра по сроку — экран «Задачи» и будущий крон напоминаний.
CREATE INDEX IF NOT EXISTS crm_tasks_partner_open_idx
  ON crm_tasks (partner_id, due_at) WHERE done_at IS NULL;
-- Выполненные — свежие сверху.
CREATE INDEX IF NOT EXISTS crm_tasks_partner_done_idx
  ON crm_tasks (partner_id, done_at DESC) WHERE done_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_tasks_contact_idx
  ON crm_tasks (contact_id) WHERE contact_id IS NOT NULL;

-- Лента: новый вид task_done — его производитель completeTask (lib/crm/tasks.ts).
ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_kind_check;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_kind_check CHECK (kind IN (
  'status_change', 'change', 'note', 'call', 'meeting', 'message_in', 'message_out', 'task_done'
));

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_kind_check;
-- ALTER TABLE crm_events ADD CONSTRAINT crm_events_kind_check CHECK (kind IN (
--   'status_change', 'change', 'note', 'call', 'meeting', 'message_in', 'message_out'
-- ));
-- DROP TABLE IF EXISTS crm_tasks;
-- COMMIT;
