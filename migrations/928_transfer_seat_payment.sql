-- 928: оплата места в поездке перевозчика по QR СБП (Точка).
--
-- Решение владельца 02.09 («делай по QR»): деньги за место идут тем же
-- приёмником, что и СБП-оплата туров, — /api/payments/tochka/webhook, — а
-- CloudPayments для трансферов не заводится. Ветка приёмника находит заказ по
-- qrcId, поэтому идентификатор QR хранится на самом заказе мест.
--
-- Что здесь НЕ делается и почему:
--   · комиссия не пишется в operator_commissions — та таблица связана с
--     operator_bookings/operator_tours (JOIN в recordCommissionFromBooking),
--     заказ мест туда не ложится. Доля платформы фиксируется на самом заказе
--     (platform_fee) из partners.commission_current перевозчика — тем же
--     источником ставки, что у туров (миграция 811), без второго реестра;
--   · повторный выпуск QR не предусмотрен: qrcId один на заказ (частичный
--     уникальный индекс). Второй QR при живом первом означал бы, что оплата по
--     первому пришла бы на неизвестный приёмнику идентификатор и потерялась
--     молча — цена выше неудобства «QR истёк, напишите перевозчику».

-- payment_status: unpaid — QR не выпускался, pending — QR выпущен и банк ещё
-- не подтвердил, paid — банк подтвердил и сумма сверена. «Не выяснили»
-- состоянием не является: при отказе банка приёмник просит повтор вебхука, а
-- запись не меняется.
--
-- platform_fee — доля платформы, посчитанная В МОМЕНТ оплаты по ставке
-- перевозчика на тот момент. Хранится, а не выводится: ставка договорная и
-- может измениться, а начисленное — нет.
--
-- Комментарии стоят НАД оператором, а не внутри: сторож schema-usage режет
-- ALTER по первой точке с запятой, и точка с запятой в комментарии между
-- колонками прятала от него всё, что объявлено ниже неё.
ALTER TABLE transfer_seat_bookings
  ADD COLUMN IF NOT EXISTS tochka_qr_id    VARCHAR(64),
  ADD COLUMN IF NOT EXISTS qr_expires_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_status  VARCHAR(20) NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid', 'pending', 'paid')),
  ADD COLUMN IF NOT EXISTS paid_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_amount     NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS platform_fee    NUMERIC(10,2);

-- Один qrcId — один заказ: вебхук ищет по нему, и два заказа на один QR были
-- бы неразрешимым вопросом «чьи деньги».
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_seat_bookings_qr
  ON transfer_seat_bookings(tochka_qr_id) WHERE tochka_qr_id IS NOT NULL;
