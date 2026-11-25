-- 1513: скидки и наценки тура — с отметкой проверки.
-- Created: 2026-11-23
--
-- ── Повод ─────────────────────────────────────────────────────────────────
--
-- Слово владельца 23.11: «Наценки тоже показываются в модерации: цена тура
-- меняется только через одну дверь».
--
-- Цену, которую видит турист, задают два канала: `operator_tours.base_price`
-- (с 1507 — через очередь проверки) и правила `tour_pricing_rules` (скидка на
-- последние места, скидка группе, наценка на выходные). Второй канал очереди
-- не касался: правило владельца начинало менять цену на сайте в ту же секунду.
--
-- Здесь — только отметка проверки у правила и запрос на его снятие. Цену
-- считают по правилам со статусом `approved`
-- (lib/tours/pricing-rule-live, `livePricingRuleSql`).
--
-- ── Существующие правила ──────────────────────────────────────────────────
--
-- Колонка добавляется с умолчанием `approved`: все правила, которые есть
-- сейчас, остаются действующими, и ни одна цена на сайте не меняется.
-- Сразу после этого умолчание переводится в `pending`: правило, записанное
-- кодом, который статус не назвал, цену не меняет, пока его не проверили
-- (отказ в безопасную сторону).
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; ограничение — через проверку каталога;
-- CREATE INDEX IF NOT EXISTS. Повторный прогон статусы строк не трогает.

BEGIN;

ALTER TABLE tour_pricing_rules
  ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(20) NOT NULL DEFAULT 'approved';

ALTER TABLE tour_pricing_rules
  ALTER COLUMN moderation_status SET DEFAULT 'pending';

ALTER TABLE tour_pricing_rules
  ADD COLUMN IF NOT EXISTS moderation_reason TEXT,
  ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS moderated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Кто попросил правило (users.id владельца или менеджера кабинета).
  ADD COLUMN IF NOT EXISTS requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Владелец попросил снять действующее правило: до решения оно действует.
  ADD COLUMN IF NOT EXISTS removal_requested_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tour_pricing_rules_moderation_status_check'
  ) THEN
    ALTER TABLE tour_pricing_rules
      ADD CONSTRAINT tour_pricing_rules_moderation_status_check
      CHECK (moderation_status IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;

-- Очередь администратора: правила на проверке и запросы на снятие.
CREATE INDEX IF NOT EXISTS tour_pricing_rules_review_queue
  ON tour_pricing_rules (created_at)
  WHERE is_active = TRUE AND (moderation_status = 'pending' OR removal_requested_at IS NOT NULL);

COMMENT ON COLUMN tour_pricing_rules.moderation_status IS
  'Проверка правила (1513): pending — цену не меняет, approved — действует, rejected — отклонено';
COMMENT ON COLUMN tour_pricing_rules.removal_requested_at IS
  'Владелец попросил снять действующее правило (1513); до решения администратора правило действует';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP INDEX IF EXISTS tour_pricing_rules_review_queue;
-- ALTER TABLE tour_pricing_rules DROP CONSTRAINT IF EXISTS tour_pricing_rules_moderation_status_check;
-- ALTER TABLE tour_pricing_rules
--   DROP COLUMN IF EXISTS removal_requested_at, DROP COLUMN IF EXISTS requested_by,
--   DROP COLUMN IF EXISTS moderated_by, DROP COLUMN IF EXISTS moderated_at,
--   DROP COLUMN IF EXISTS moderation_reason, DROP COLUMN IF EXISTS moderation_status;
-- COMMIT;
