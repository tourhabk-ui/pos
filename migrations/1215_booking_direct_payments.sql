-- Migration 1215: оплата напрямую оператору — отметка, отдельная от оплаты через платформу (CRM фаза 2в)
-- Created: 2026-10-11
--
-- Перепись 09.10 (#2313, пробел 8): «Нет отметки „оплачено напрямую“. Пока
-- приём оплаты выключен (05.10), „Получено“ у оператора пусто». Туристы платят
-- операторам сами — наличными, переводом, по терминалу; кабинет этого не знал.
--
-- Решение владельца 11.10 («2в да»): отметка ОТДЕЛЬНАЯ от оплаты через
-- платформу. `operator_bookings.paid_at` и `payment_status` значат «деньги
-- прошли через платформу» и запускают книгу tour_payments, комиссию и выплату
-- (§7 CLAUDE.md). Эта таблица их не трогает и ими не читается: деньги,
-- полученные оператором напрямую, через платформу не проходили, комиссии и
-- выплаты по ним нет.
--
-- Записей у брони несколько: предоплата и остаток — обычный порядок на
-- Камчатке. Ошибочная запись не удаляется, а аннулируется с причиной
-- (voided_*): деньги не исчезают из истории молча.
--
-- Пишет и читает: /api/hub/operator/bookings/[id]/direct-payments (карточка
-- брони оператора); сумму за 30 дней — /api/hub/operator/earnings.

BEGIN;

CREATE TABLE IF NOT EXISTS booking_direct_payments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   BIGINT NOT NULL REFERENCES operator_bookings(id) ON DELETE CASCADE,
  amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method       TEXT NOT NULL CHECK (method IN ('cash', 'transfer', 'card', 'other')),
  received_on  DATE NOT NULL,
  note         TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  recorded_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_at    TIMESTAMPTZ,
  voided_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason  TEXT,
  -- Аннулирование целиком: время и причина вместе.
  CONSTRAINT booking_direct_payments_void_complete CHECK (
    (voided_at IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND void_reason IS NOT NULL AND char_length(void_reason) >= 3)
  )
);

CREATE INDEX IF NOT EXISTS idx_booking_direct_payments_booking
  ON booking_direct_payments(booking_id);
CREATE INDEX IF NOT EXISTS idx_booking_direct_payments_received
  ON booking_direct_payments(received_on) WHERE voided_at IS NULL;

COMMENT ON TABLE booking_direct_payments IS 'Деньги, полученные оператором напрямую (наличные, перевод, терминал). Не оплата через платформу: paid_at, tour_payments и комиссию не трогает.';
COMMENT ON COLUMN booking_direct_payments.voided_at IS 'Запись аннулирована (ошибка ввода). NULL — действует.';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS booking_direct_payments;
-- COMMIT;
