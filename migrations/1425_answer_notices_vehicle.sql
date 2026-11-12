-- 1425: сообщение заказчику после «Не могу» перевозчика и прокатчика.
-- Created: 2026-11-12
--
-- План «после отказа» (слово владельца 12.11 «1 да» — продолжать с этапа
-- 2б-2). Таблица 1424 знала один источник ответа — кнопку туроператора
-- (partner_incoming_answers). Ответ перевозчика и прокатчика лежит в другой
-- таблице: одна строка `lead_activity_log.partner_answered` на заявку (1326).
-- До этой миграции их «Не могу» заказчику Ведар не сообщал: у проката —
-- вовсе, у машины — словами перевозчика с обещанием «менеджер свяжется»,
-- которое система не отслеживала (заявка закрывалась как отказ).
--
-- Теперь у строки сообщения ровно одна ссылка на ответ: `answer_id` (тур)
-- или `activity_id` (машина, прокат). Уведомление рождается в той же
-- транзакции, что и запись журнала (claimPartnerAnswer), — повтор нажатия
-- второго сообщения не даёт. ПД в таблице по-прежнему нет.

BEGIN;

ALTER TABLE answer_notices ALTER COLUMN answer_id DROP NOT NULL;

ALTER TABLE answer_notices
  ADD COLUMN IF NOT EXISTS activity_id BIGINT NULL REFERENCES lead_activity_log(id) ON DELETE CASCADE;

-- Одна строка сообщения на один ответ журнала.
CREATE UNIQUE INDEX IF NOT EXISTS answer_notices_activity_uidx
  ON answer_notices (activity_id) WHERE activity_id IS NOT NULL;

-- Ровно одна ссылка: либо кнопка туроператора, либо запись журнала.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'answer_notices_ref_check') THEN
    ALTER TABLE answer_notices
      ADD CONSTRAINT answer_notices_ref_check CHECK ((answer_id IS NULL) <> (activity_id IS NULL));
  END IF;
END $$;

COMMENT ON COLUMN answer_notices.activity_id IS
  'Ответ перевозчика или прокатчика — запись lead_activity_log.partner_answered (план «после отказа», 2б-2).';

COMMIT;

-- Rollback:
-- BEGIN;
-- DELETE FROM answer_notices WHERE activity_id IS NOT NULL;
-- ALTER TABLE answer_notices DROP CONSTRAINT IF EXISTS answer_notices_ref_check;
-- DROP INDEX IF EXISTS answer_notices_activity_uidx;
-- ALTER TABLE answer_notices DROP COLUMN IF EXISTS activity_id;
-- ALTER TABLE answer_notices ALTER COLUMN answer_id SET NOT NULL;
-- COMMIT;
