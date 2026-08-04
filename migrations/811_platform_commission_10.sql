-- Migration 811: единая комиссия платформы — 10%
--
-- Решение владельца (04.08): «пока нет партнёров делаем 10%». До этого ставка
-- жила в ТРЁХ местах и в трёх разных значениях:
--   • partners.commission_start / commission_current — 15% (дефолт, миграция 051);
--   • /api/payments/webhook — захардкоженные 12% (шли в operator_commissions);
--   • /api/bookings/tour и hub-вебхук — договорные ~15% (шли в tour_payments).
-- Одна и та же бронь получала разную комиссию в разных таблицах.
--
-- Здесь приводим ДАННЫЕ к 10%: дефолты колонок и текущие значения у партнёров.
-- Код переведён на ту же величину (lib/payments/commission.ts), поэтому больше
-- сверять нечего — источник один, база.
--
-- commission_start трогаем вместе с current: он база для спящей функции
-- recalculate_commission (051). Её сейчас никто не вызывает, но если однажды
-- включат — она вернула бы ставку к commission_start, и 10% молча уехали бы.
--
-- Идемпотентна: повторный прогон ничего не меняет.

ALTER TABLE partners ALTER COLUMN commission_current SET DEFAULT 10.00;
ALTER TABLE partners ALTER COLUMN commission_start   SET DEFAULT 10.00;

UPDATE partners
   SET commission_current = 10.00,
       commission_start   = 10.00,
       updated_at         = NOW()
 WHERE commission_current IS DISTINCT FROM 10.00
    OR commission_start   IS DISTINCT FROM 10.00;
