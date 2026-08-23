-- 911: согласие на обработку ПД у лида (152-ФЗ)
--
-- Замер 23.08: галочка «согласен на обработку персональных данных» стояла на
-- двух формах из девяти, ЖИЛА ТОЛЬКО В БРАУЗЕРЕ и на сервер не приходила. В
-- таблице leads не было ни одного поля о согласии. То есть имя и телефон
-- собирались, а доказательства права их собирать не существовало нигде.
--
-- Пишем не булево, а обстоятельства: когда, с какого адреса, из какой формы и
-- под КАКОЙ версией формулировки. Булево через год не докажет ничего —
-- непонятно, на что человек соглашался.
--
-- NULL здесь означает «согласие не зафиксировано», а НЕ «отказано»: лид может
-- прийти из бота или MCP, где формы с галочкой нет. Третье состояние (§4.0
-- CLAUDE.md) видно и считается, а не выдаётся за согласие.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS pd_consent_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pd_consent_ip      VARCHAR(64),
  ADD COLUMN IF NOT EXISTS pd_consent_source  VARCHAR(64),
  ADD COLUMN IF NOT EXISTS pd_consent_version VARCHAR(32);

COMMENT ON COLUMN leads.pd_consent_at      IS 'Когда дано согласие на обработку ПД. NULL — согласие не зафиксировано (не отказ).';
COMMENT ON COLUMN leads.pd_consent_ip      IS 'Адрес, с которого дано согласие.';
COMMENT ON COLUMN leads.pd_consent_source  IS 'Форма/канал, где дано согласие: web-form, widget, operator-signup.';
COMMENT ON COLUMN leads.pd_consent_version IS 'Версия формулировки согласия (lib/legal/pd-consent.ts).';

-- Отбор лидов без зафиксированного согласия — для переписи и для крона
-- удержания: их нельзя обрабатывать так же, как остальные.
CREATE INDEX IF NOT EXISTS idx_leads_pd_consent_missing
  ON leads (created_at DESC)
  WHERE pd_consent_at IS NULL;
