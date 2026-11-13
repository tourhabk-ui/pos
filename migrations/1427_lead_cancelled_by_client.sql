-- 1427: статус заявки «отменена клиентом» и по одной записи отмены на заявку.
-- Created: 2026-11-12
--
-- Слово владельца 11.11: заявку можно отменить и перенести «как самим
-- человеком» — пока адресат не ответил, сразу; после ответа — просьбой ему.
-- До этой миграции у лида не было слова для «отменил клиент»: единственный
-- закрывающий статус `lost` ставят продавцы, и читается он как «оператор
-- отказал» — человеку, ИИ-агенту, оператору и крону, который по нему отдаёт
-- большую группу другим операторам. Отмена под видом `lost` говорила бы
-- неправду всем четверым.
--
-- 1. `cancelled` в CHECK статусов (083). Ставит его только отмена клиентом
--    (lib/requests/cancel-request): вручную его не выбирают, и из него
--    заявку не возвращают (lib/leads/owner-lead-status).
-- 2. Одна запись «отменил клиент» (`client_cancelled`) и одна просьба об
--    отмене (`cancel_requested`) на заявку — уникальными индексами, как у
--    ответа перевозчика (1326): повтор нажатия или параллельный вызов не
--    даёт второго сообщения оператору.

BEGIN;

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check
  CHECK (status IN (
    'new',
    'ai_processing',
    'ai_qualified',
    'proposal_sent',
    'awaiting_confirm',
    'contacted',
    'qualified',
    'converted',
    'lost',
    'cancelled'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS lead_activity_log_client_cancelled_uidx
  ON lead_activity_log (lead_id)
  WHERE action = 'client_cancelled';

CREATE UNIQUE INDEX IF NOT EXISTS lead_activity_log_cancel_requested_uidx
  ON lead_activity_log (lead_id)
  WHERE action = 'cancel_requested';

COMMENT ON INDEX lead_activity_log_client_cancelled_uidx IS
  'Одна отмена клиентом на заявку (lib/requests/cancel-request).';
COMMENT ON INDEX lead_activity_log_cancel_requested_uidx IS
  'Одна просьба клиента об отмене на заявку: после ответа адресата отменяет он.';

COMMIT;

-- Rollback (сначала убедиться, что строк со статусом cancelled нет):
-- BEGIN;
-- DROP INDEX IF EXISTS lead_activity_log_cancel_requested_uidx;
-- DROP INDEX IF EXISTS lead_activity_log_client_cancelled_uidx;
-- ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
-- ALTER TABLE leads ADD CONSTRAINT leads_status_check
--   CHECK (status IN ('new','ai_processing','ai_qualified','proposal_sent','awaiting_confirm','contacted','qualified','converted','lost'));
-- COMMIT;
