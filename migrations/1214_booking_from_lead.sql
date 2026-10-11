-- Migration 1214: бронь помнит лид, из которого её завели (CRM фаза 2, #2313)
-- Created: 2026-10-11
--
-- Перепись 09.10 (#2313, пробел 2): «Лид не доводится до сделки. У leads
-- нет ссылки на бронь, converted ставят руками». Оператор звонил по лиду,
-- заводил ручную бронь в другом разделе, а лид оставался «новым» или его
-- двигали в «Сделку» вручную — и по какой брони сделка, не знал никто.
--
-- operator_bookings.lead_id — лид, из которого оператор завёл бронь кнопкой
-- «Завести бронь» на карточке лида:
--   * пишет POST /api/hub/operator/bookings (поле lead_id) — в том же
--     запросе, что ставит лиду «Сделку» (converted);
--   * читает карточка лида (GET /api/leads/[id] → bookings) — «по этому
--     лиду заведены брони».
-- Лидов у брони один, броней у лида может быть несколько (два тура одной
-- семье). Удалили лид — ссылка гаснет, бронь остаётся (ON DELETE SET NULL).
-- NULL — бронь заведена не из лида (сайт, звонок без лида, агент, MCP).

BEGIN;

ALTER TABLE operator_bookings
  ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_operator_bookings_lead_id
  ON operator_bookings(lead_id) WHERE lead_id IS NOT NULL;

COMMENT ON COLUMN operator_bookings.lead_id IS 'Лид, из которого оператор завёл бронь (CRM фаза 2). NULL — бронь не из лида.';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP INDEX IF EXISTS idx_operator_bookings_lead_id;
-- ALTER TABLE operator_bookings DROP COLUMN IF EXISTS lead_id;
-- COMMIT;
