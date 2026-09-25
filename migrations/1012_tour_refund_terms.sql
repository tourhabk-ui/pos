-- 1012: условия отмены тура — числами для счёта, и сумма возврата, записанная
-- в момент отмены.
--
-- Решение владельца 24.09: возврат туристу при отмене — «как у оператора»
-- (пересматривает 11.09 «100% всегда»). Условия оператора до сих пор жили
-- только текстом (`cancellation_policy`, 931/935) — для человека. Счёт по
-- тексту — это парсер свободной фразы, который однажды прочтёт «за 3 дня»
-- в чужой формулировке неверно и молча. Поэтому рядом с текстом — два числа:
--
--   cancellation_free_days            за сколько календарных дней до тура
--                                     (по Камчатке) отмена бесплатна;
--   cancellation_late_refund_percent  сколько процентов вернуть позже.
--
-- NULL в любом из них — «условия не записаны», и возврат тогда 100%
-- (решение владельца 24.09): пробел в данных не должен стоить туристу денег.
-- Правило счёта — lib/payments/tour-refund.ts.
--
-- Заполняются только туры, чей текст — ДОСЛОВНО правило владельца 05.09 из
-- 935 («Бесплатная отмена за 3 дня до тура, позже удерживается 50%»):
-- удерживается 50% — значит возвращается 50%. Текст, который оператор
-- написал сам, не угадывается — числа у такого тура остаются NULL.

ALTER TABLE operator_tours
  ADD COLUMN IF NOT EXISTS cancellation_free_days INTEGER
    CHECK (cancellation_free_days IS NULL OR (cancellation_free_days >= 0 AND cancellation_free_days <= 365)),
  ADD COLUMN IF NOT EXISTS cancellation_late_refund_percent INTEGER
    CHECK (cancellation_late_refund_percent IS NULL OR (cancellation_late_refund_percent >= 0 AND cancellation_late_refund_percent <= 100));

COMMENT ON COLUMN operator_tours.cancellation_free_days IS
  'За сколько календарных дней до тура (Камчатка) отмена туристом бесплатна. NULL — условия не записаны, возврат 100%.';
COMMENT ON COLUMN operator_tours.cancellation_late_refund_percent IS
  'Процент возврата при отмене туристом позже срока. NULL — условия не записаны, возврат 100%.';

UPDATE operator_tours
   SET cancellation_free_days = 3,
       cancellation_late_refund_percent = 50
 WHERE cancellation_free_days IS NULL
   AND cancellation_late_refund_percent IS NULL
   AND RTRIM(TRIM(cancellation_policy), '.') = 'Бесплатная отмена за 3 дня до тура, позже удерживается 50%';

-- Сумма, которую платформа обязана вернуть, считается в МОМЕНТ отмены и
-- записывается здесь: позже её не восстановить — условия тура могут
-- поменяться, а «когда отменили» и «кто отменил» в брони не хранится
-- отдельными полями. Администратор при отметке возврата
-- (/api/admin/finance/refunds) пишет в refund_amount именно её. NULL у
-- отменённой брони — отмена случилась до 1012: тогда действовало «100%».

ALTER TABLE tour_payments
  ADD COLUMN IF NOT EXISTS refund_due NUMERIC(12,2)
    CHECK (refund_due IS NULL OR refund_due >= 0),
  ADD COLUMN IF NOT EXISTS refund_due_reason TEXT;

COMMENT ON COLUMN tour_payments.refund_due IS
  'Сколько вернуть туристу — посчитано при отмене по условиям тура (lib/payments/tour-refund.ts). NULL — отмены не было или она до 1012 (тогда 100%).';
COMMENT ON COLUMN tour_payments.refund_due_reason IS
  'Почему столько — та же фраза, что ушла туристу.';

INSERT INTO _migrations (name)
VALUES ('1012_tour_refund_terms.sql')
ON CONFLICT (name) DO NOTHING;
