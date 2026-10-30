-- Migration 1352: заявка на машину во «Входящих» перевозчика — вид напоминания
-- Created: 2026-10-30
--
-- #2862 этап A (слово владельца 30.10 «нужно тоже продумать CRM полное с ТГ
-- и MAX и закрыть дыры»): перевозчик отвечает на заявку на машину целиком
-- («Беру» / «Не могу») через платформу, и заявка без ответа два часа идёт в
-- напоминание (lib/crm/inbox-reminders) под видом `charter_request`. CHECK
-- таблицы напоминаний (1201) перечисляет виды поимённо — иначе первая же
-- запись исхода упала бы на 23514, а напоминание повторялось бы каждые
-- полчаса. Снятый товар «места в машине» (`transfer_seat_booking`, 13.10)
-- из ящика и напоминаний убран; уже записанные исходы с этим видом остаются
-- (история), поэтому старое значение в CHECK не снимается.

BEGIN;

ALTER TABLE crm_inbox_reminders DROP CONSTRAINT IF EXISTS crm_inbox_reminders_kind_check;
ALTER TABLE crm_inbox_reminders ADD CONSTRAINT crm_inbox_reminders_kind_check CHECK (item_kind IN (
  'operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking', 'guide_invite', 'charter_request'
));

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE crm_inbox_reminders DROP CONSTRAINT IF EXISTS crm_inbox_reminders_kind_check;
-- ALTER TABLE crm_inbox_reminders ADD CONSTRAINT crm_inbox_reminders_kind_check CHECK (item_kind IN (
--   'operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking', 'guide_invite'
-- ));
-- COMMIT;
