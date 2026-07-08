-- Migration 725: поля возврата у броней жилья (напоминание владельцу №6)
--
-- Отмена оплаченной брони жилья оставляла payment_status='paid' — деньги
-- «зависали», возврат нигде не фиксировался. Приводим отмену жилья к
-- тур-конвенции: сумму возврата считаем по политике и фиксируем в БД,
-- физический возврат по CloudPayments — офлайн (как у туров/трансферов,
-- живой refund-API в коде нет; app/api/payments не трогаем, CLAUDE.md §7).
--
-- Enum payment_status уже включает 'refunded'/'partially_refunded'
-- (migration 716) — их только начали присваивать. Здесь добавляем поля
-- суммы/процента/причины/времени отмены.
--
-- Идемпотентна: safe to run multiple times.

BEGIN;

ALTER TABLE accommodation_bookings ADD COLUMN IF NOT EXISTS refund_amount  NUMERIC(10,2);
ALTER TABLE accommodation_bookings ADD COLUMN IF NOT EXISTS refund_percent INTEGER;
ALTER TABLE accommodation_bookings ADD COLUMN IF NOT EXISTS refund_reason  TEXT;
ALTER TABLE accommodation_bookings ADD COLUMN IF NOT EXISTS cancelled_at   TIMESTAMPTZ;

COMMIT;
