-- Migration 1350: переписка по любой заявке партнёру — не только жильё
-- Created: 2026-10-30
--
-- Слово владельца 30.10 («Единый чат для всех»): та же переписка, что у
-- владельца жилья (1349), — для заявок туроператору и гиду, перевозчику и
-- прокату. Все они живут в `leads` с адресатом `operator_id`.
--
-- 1. Таблицы 1349 становятся общими: stay_request_messages →
--    request_messages, stay_chat_waits → request_chat_waits. Цель — ровно
--    одна из двух колонок: заявка на жильё или лид (тот же приём, что у
--    ключа статуса, 1238). Удалили заявку или лид — переписка и ожидания
--    уходят с ними (ON DELETE CASCADE).
--    Автор `owner` остаётся значением стороны АДРЕСАТА заявки: владелец
--    жилья, туроператор, гид, перевозчик, прокат. Переименование значения
--    сломало бы запись у сервера, который ещё работает на прежнем коде во
--    время выката, — а смысл тот же: сторона, которой адресована заявка.
--    Имена проверок и индексов 1349 остаются прежними по той же причине.
--
-- 2. leads.guest_max_chat_id — личный чат клиента с ботом MAX, по «Старту»
--    со ссылкой ключа статуса заявки (1238). Чужой чат не перезаписывается:
--    условие в UPDATE, как у заявки на жильё.
--
-- 3. agent_request_keys.opens_chat — ключ открывает переписку; почему только
--    ключ новой заявки — у самой колонки ниже.
--
-- 4. Окно выката и откат кода. Сервер на прежнем коде (1349) между накатом
--    миграции и стартом нового обращается к старым именам, а миграции —
--    только вперёд: откат кода оставил бы новые имена, и прежний код упал бы
--    на 42P01 — статус ЛЮБОЙ заявки читает переписку. Поэтому старые имена
--    остаются представлениями над новыми таблицами: простые (одна таблица,
--    без агрегатов), значит изменяемые — INSERT, UPDATE и SELECT прежнего
--    кода работают как раньше и видят только заявки на жильё. Новый код к
--    ним не обращается (сторож — tests/unit/request-chat-compat.test.ts).
--    Снять — отдельной миграцией, когда откат этого шага не понадобится.
--    Ключ жилья, выданный прежним кодом в окне выката (opens_chat — FALSE по
--    умолчанию), переписку открывает всё равно: у жилья склейки нет, и код
--    читает «открывает» как opens_chat ИЛИ ключ заявки на жильё.
--
-- Идемпотентна: переименование — только таблицы (на повторе под старым
-- именем уже представление, а ALTER TABLE ... RENAME переименовал бы его),
-- колонки — IF NOT EXISTS, проверки — DROP IF EXISTS и заново,
-- представления — CREATE OR REPLACE.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = current_schema() AND c.relname = 'stay_request_messages' AND c.relkind = 'r') THEN
    ALTER TABLE stay_request_messages RENAME TO request_messages;
  END IF;
END $$;
ALTER TABLE request_messages ALTER COLUMN stay_request_id DROP NOT NULL;
ALTER TABLE request_messages ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id) ON DELETE CASCADE;
ALTER TABLE request_messages DROP CONSTRAINT IF EXISTS request_messages_one_target;
ALTER TABLE request_messages ADD CONSTRAINT request_messages_one_target
  CHECK (((stay_request_id IS NOT NULL)::int + (lead_id IS NOT NULL)::int) = 1);
CREATE INDEX IF NOT EXISTS request_messages_lead_idx
  ON request_messages (lead_id, created_at) WHERE lead_id IS NOT NULL;

COMMENT ON TABLE request_messages IS
  'Переписка адресата заявки (владелец жилья, туроператор, гид, перевозчик, прокат) и клиента (1349, 1350). Цель — заявка на жильё или лид, ровно одна. author owner — сторона адресата. Текст — слова людей; в промпты моделей и в ответы инструментов MCP не уходит.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = current_schema() AND c.relname = 'stay_chat_waits' AND c.relkind = 'r') THEN
    ALTER TABLE stay_chat_waits RENAME TO request_chat_waits;
  END IF;
END $$;
ALTER TABLE request_chat_waits ALTER COLUMN stay_request_id DROP NOT NULL;
ALTER TABLE request_chat_waits ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id) ON DELETE CASCADE;
ALTER TABLE request_chat_waits DROP CONSTRAINT IF EXISTS request_chat_waits_one_target;
ALTER TABLE request_chat_waits ADD CONSTRAINT request_chat_waits_one_target
  CHECK (((stay_request_id IS NOT NULL)::int + (lead_id IS NOT NULL)::int) = 1);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS guest_max_chat_id BIGINT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS guest_chat_bound_at TIMESTAMPTZ;

COMMENT ON COLUMN leads.guest_max_chat_id IS
  'Личный чат клиента с ботом MAX — по «Старту» со ссылкой ключа статуса заявки (1350). Чужой чат не перезаписывается.';

-- 3. Переписку открывает только ключ НОВОЙ заявки. Повтор лида (тот же
--    телефон и комментарий за сутки — createLead; тот же телефон, компания и
--    дата — заявка на машину и прокат) возвращает прежний лид, и ключ,
--    выданный на повтор, вёл бы в чужую переписку: телефон — не секрет (тот
--    же довод, что у ключа запроса мест, 29.09). Такой ключ показывает только
--    статус. Заявка на жильё (1206) не склеивается никогда — каждая отправка
--    новая строка, — поэтому её ключи, выданные до этой миграции, переписку
--    открывают.
ALTER TABLE agent_request_keys ADD COLUMN IF NOT EXISTS opens_chat BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE agent_request_keys SET opens_chat = TRUE WHERE stay_request_id IS NOT NULL AND opens_chat = FALSE;

COMMENT ON COLUMN agent_request_keys.opens_chat IS
  'Ключ открывает переписку с адресатом заявки (1350): выдан вместе с НОВОЙ заявкой. Ключ повтора — только статус. Ключ заявки на жильё открывает переписку при любом значении: склейки у жилья нет.';

-- 4. Прежние имена — представлениями (см. шапку).
CREATE OR REPLACE VIEW stay_request_messages AS
  SELECT id, stay_request_id, author, door, body, delivery_channel, delivery_reason, created_at
    FROM request_messages
   WHERE stay_request_id IS NOT NULL;

CREATE OR REPLACE VIEW stay_chat_waits AS
  SELECT id, channel, chat_id, stay_request_id, side, status, created_at, expires_at, used_at
    FROM request_chat_waits
   WHERE stay_request_id IS NOT NULL;

COMMENT ON VIEW stay_request_messages IS
  'Совместимость 1350: прежнее имя переписки по заявке на жильё для кода 1349 (окно выката, откат). Новый код читает request_messages.';
COMMENT ON VIEW stay_chat_waits IS
  'Совместимость 1350: прежнее имя ожиданий переписки для кода 1349 (окно выката, откат). Новый код читает request_chat_waits.';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP VIEW IF EXISTS stay_chat_waits;
-- DROP VIEW IF EXISTS stay_request_messages;
-- ALTER TABLE agent_request_keys DROP COLUMN IF EXISTS opens_chat;
-- ALTER TABLE leads DROP COLUMN IF EXISTS guest_chat_bound_at;
-- ALTER TABLE leads DROP COLUMN IF EXISTS guest_max_chat_id;
-- DELETE FROM request_chat_waits WHERE lead_id IS NOT NULL;
-- ALTER TABLE request_chat_waits DROP CONSTRAINT IF EXISTS request_chat_waits_one_target;
-- ALTER TABLE request_chat_waits DROP COLUMN IF EXISTS lead_id;
-- ALTER TABLE request_chat_waits ALTER COLUMN stay_request_id SET NOT NULL;
-- ALTER TABLE request_chat_waits RENAME TO stay_chat_waits;
-- DELETE FROM request_messages WHERE lead_id IS NOT NULL;
-- DROP INDEX IF EXISTS request_messages_lead_idx;
-- ALTER TABLE request_messages DROP CONSTRAINT IF EXISTS request_messages_one_target;
-- ALTER TABLE request_messages DROP COLUMN IF EXISTS lead_id;
-- ALTER TABLE request_messages ALTER COLUMN stay_request_id SET NOT NULL;
-- ALTER TABLE request_messages RENAME TO stay_request_messages;
-- COMMIT;
