-- 1024: выплата агенту — заявка из продаж и отметка администратора.
--
-- ── Решение владельца 26.09 ────────────────────────────────────────────────
-- Комиссия агента начисляется только с ОПЛАЧЕННОЙ и НЕ отменённой брони,
-- засчитанной агенту (operator_bookings.agent_user_id, миграция 1022), и
-- становится к выплате только после конца тура + 36 часов — тот же срок, что
-- у выплаты оператору (RELEASE_AFTER_SQL). Агент запрашивает выплату;
-- администратор переводит деньги вне платформы и отмечает факт с
-- обязательным основанием — как возврат туристу (/api/admin/finance/refunds).
--
-- ── Модель ─────────────────────────────────────────────────────────────────
-- Причитающееся считается на чтении (lib/payments/agent-commission.ts), а в
-- момент заявки фиксируется снимком: agent_payout_items — по строке на бронь,
-- с суммой продажи, ставкой и суммой на тот момент. Поэтому:
--   * смена ставки не переписывает уже запрошенное и выплаченное;
--   * одну бронь нельзя выплатить дважды — уникальный индекс по booking_id
--     среди живых позиций (released_at IS NULL). Отклонённая заявка
--     освобождает свои позиции, и агент может запросить их снова;
--   * у агента одна открытая заявка — уникальный индекс по agent_id среди
--     заявок в статусе pending.
--
-- ── commission_payouts: переиспользуется, старые строки не трогаются ──────
-- Таблица уже была (baseline), но её единственный писатель
-- (/api/agent/commissions/request-payout) не выполнялся НИ РАЗУ: текстовый
-- id 'payout-…' в uuid-колонку (22P02) и статус 'processing', которого нет в
-- CHECK agent_commissions. Строк от него быть не может; сервис
-- payment.service, писавший туда же, не звал никто. Если строки всё же есть
-- (ручная вставка), они не выдаются за выплату из продаж: признак from_sales
-- у них FALSE, и новые экраны читают только from_sales = TRUE.
--
-- Статусы новой заявки: pending → paid | rejected. Прежние значения CHECK
-- (processing, failed) оставлены допустимыми, чтобы не уронить миграцию на
-- гипотетической старой строке; новый код их не пишет и не показывает.

ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS from_sales    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS paid_by       UUID NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS paid_at       TIMESTAMPTZ NULL;
ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS paid_reason   TEXT NULL;
ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS rejected_by   UUID NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS rejected_at   TIMESTAMPTZ NULL;
ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS reject_reason TEXT NULL;

ALTER TABLE commission_payouts DROP CONSTRAINT IF EXISTS commission_payouts_status_check;
ALTER TABLE commission_payouts ADD CONSTRAINT commission_payouts_status_check
  CHECK (status IN ('pending', 'paid', 'rejected', 'processing', 'failed'));

-- Одна открытая заявка на агента.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_payouts_open_per_agent
  ON commission_payouts (agent_id)
  WHERE status = 'pending' AND from_sales;

CREATE TABLE IF NOT EXISTS agent_payout_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id     UUID NOT NULL REFERENCES commission_payouts(id) ON DELETE RESTRICT,
  agent_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  booking_id    BIGINT NOT NULL REFERENCES operator_bookings(id) ON DELETE RESTRICT,
  sale_amount   NUMERIC(12,2) NOT NULL CHECK (sale_amount >= 0),
  rate          NUMERIC(5,2)  NOT NULL CHECK (rate >= 0 AND rate <= 30),
  amount        NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  -- Заявка отклонена: позиция освобождена и может войти в новую заявку.
  released_at   TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Одна бронь — не больше одной живой позиции: дважды не выплатить.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_payout_items_booking_live
  ON agent_payout_items (booking_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_payout_items_payout
  ON agent_payout_items (payout_id);

CREATE INDEX IF NOT EXISTS idx_agent_payout_items_agent
  ON agent_payout_items (agent_user_id);
