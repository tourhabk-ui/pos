-- 1326: один ответ прокатчика на заявку.
--
-- «Беру» и «Не могу» пишутся в lead_activity_log (action partner_answered).
-- Без уникальности два нажатия сразу оба видели «ответа ещё нет»: менеджеру
-- уходили два факта, а поздний «Не могу» оставался в журнале при днях,
-- которые «Беру» уже занял. Первый записанный ответ — единственный.
-- Дни и журнал всё равно одна транзакция в коде: индекс не даёт вторую
-- строку, если транзакцию когда-нибудь обойдут.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS lead_activity_log_partner_answered_uidx
  ON lead_activity_log (lead_id)
  WHERE action = 'partner_answered';

COMMENT ON INDEX lead_activity_log_partner_answered_uidx IS
  'Один ответ прокатчика на заявку (1326). Первый «Беру» или «Не могу» не переписывается вторым нажатием';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP INDEX IF EXISTS lead_activity_log_partner_answered_uidx;
-- COMMIT;
