-- 921: affiliate_payouts — дедуп записи вебхука TravelPayouts.
--
-- Аудит write-путей 28.08: app/api/webhooks/travelpayouts/route.ts писал
-- каждое поступившее событие без единой идемпотентности — повторная
-- доставка того же события задваивала бы строку.
--
-- Честная граница: TravelPayouts не гарантирует click_id в payload
-- (PayoutSchema делает его optional) и не присылает отдельный event-id —
-- значит дедуп по (tp_click_id, status) возможен, только когда click_id
-- ЕСТЬ. Когда его нет, дедуп из самого payload невозможен — это
-- ограничение источника, а не недоделка (§4.0): такие события пишутся как
-- раньше, без гарантии.

CREATE UNIQUE INDEX IF NOT EXISTS idx_affiliate_payouts_dedup
  ON affiliate_payouts (tp_click_id, status)
  WHERE tp_click_id IS NOT NULL;

COMMENT ON INDEX idx_affiliate_payouts_dedup IS
  'Volcano OS: дедуп повторной доставки TravelPayouts-вебхука по (tp_click_id, status); события без click_id не дедуплицируются — источник не гарантирует id';
