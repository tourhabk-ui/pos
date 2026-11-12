-- Migration 1429: причина отказа продавца у заявки (план «после отказа», этап 3а)
-- Created: 2026-11-12
--
-- «Потерян» в кабинете оператора и «Отказ» у гида закрывали заявку молча:
-- причины не было, человеку ничего не уходило, а его статус читался «отказал
-- или не состоялась». Кнопка «Отказать» в чате при этом уже называла причину
-- и свободные даты рядом (1367, 1424). Теперь дверь спрашивает причину, и она
-- лежит в самой заявке:
--   - seats / weather / dates / group / other — отказ продавца (те же причины,
--     что у кнопки чата): человеку уходит сообщение Ведара;
--   - no_contact / client_declined — причина на стороне клиента: сообщение не
--     уходит, статус говорит «по словам оператора».
-- NULL — причина не записана (старые заявки и двери, которые её не спрашивают).
--
-- Причина относится к ОДНОМУ закрытию. Чтобы она не пережила его ни через одну
-- из записей статуса (их четырнадцать в девяти файлах, tests/unit/
-- lead-status-writers), сбрасывает её сама база: статус сменился, а новой
-- причины запрос не записал — прежняя стирается. Иначе заявку, закрытую
-- оператором «нет мест», вернули бы в работу, закрыли другой дверью без
-- причины — и человек прочитал бы чужую причину о новом отказе.

BEGIN;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason TEXT;

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_lost_reason_check;
ALTER TABLE leads ADD CONSTRAINT leads_lost_reason_check
  CHECK (lost_reason IS NULL
         OR lost_reason IN ('seats', 'weather', 'dates', 'group', 'other', 'no_contact', 'client_declined'));

COMMENT ON COLUMN leads.lost_reason IS
  'Причина отказа продавца у закрытой заявки (status = lost); NULL — не записана. Стирается триггером при любой смене статуса (1429).';

CREATE OR REPLACE FUNCTION leads_clear_lost_reason() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.lost_reason IS NOT DISTINCT FROM OLD.lost_reason THEN
    NEW.lost_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_leads_clear_lost_reason ON leads;
CREATE TRIGGER trg_leads_clear_lost_reason
  BEFORE UPDATE OF status ON leads
  FOR EACH ROW EXECUTE FUNCTION leads_clear_lost_reason();

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TRIGGER IF EXISTS trg_leads_clear_lost_reason ON leads;
-- DROP FUNCTION IF EXISTS leads_clear_lost_reason();
-- ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_lost_reason_check;
-- ALTER TABLE leads DROP COLUMN IF EXISTS lost_reason;
-- COMMIT;
