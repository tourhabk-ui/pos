-- 1291: CHECK на operator_bookings.booking_status по единому словарю статусов.
-- Created: 2026-10-15
--
-- ── Повод (аудит 15.10, BOOKING-CHECK; A11, п. 1.9 дорожной карты) ─────────
--
-- У колонки не было CHECK (с 040: VARCHAR(20) NOT NULL DEFAULT 'confirmed'),
-- а словарей статусов было два, расходившихся между собой (`rejected` в
-- одном, `no_show` в другом). Словарь сведён в один — BOOKING_STATUSES в
-- lib/types/statuses.ts, — но без ограничения в базе любой писатель мог
-- положить слово, которого не знает ни кабинет, ни занятость, ни сторожа, и
-- бронь молча пропадала из всех фильтров.
--
-- Порядок «сначала замер, потом CHECK» выдержан: перепись прода
-- booking-status-census (prod-check 139, 15.10): 3 строки, все `cancelled`,
-- вне словаря — ни одной, CHECK на колонке нет.
--
-- ── Писатели (опись 15.10, по коду, а не по памяти) ───────────────────────
--
--   вставка: lib/bookings/reserve.ts insertBookingRow — 'new' | 'confirmed'
--     (бронь туриста — 'new', OCTO — 'new', ручная бронь оператора — Zod
--     'new' | 'confirmed'); служебная бронь payment-test-setup —
--     'pending_payment'; умолчание колонки — 'confirmed';
--   смена: кабинет оператора (hub/operator/bookings/[id], Zod из словаря),
--     booking.service (confirmed/cancelled/completed, перенос — прежний
--     статус), отмена туристом и OCTO, кроны health и abandoned-bookings —
--     'cancelled', OCTO redeem/no-show — 'completed'/'no_show', приёмники
--     оплаты — 'confirmed'/'cancelled' или прежний;
--   вне словаря был один: PUT /api/operator/bookings/[id] писал 'pending'.
--     Поправлен в той же правке: 'pending' пишется как 'new'.
--
-- Миграции и триггеры booking_status не пишут.
--
-- ── Почему так ────────────────────────────────────────────────────────────
--
-- NOT VALID, затем VALIDATE: ограничение сначала ставится на новые записи,
-- потом проверяет существующие. На проде три строки, валидация мгновенна;
-- если бы нашлась строка вне словаря, VALIDATE упал бы (23514), файл
-- откатился бы целиком, и накат остановился бы на нём (сервер стартует на
-- прежней схеме, /api/health — migrations.state=failed), а не переписал
-- чужие данные под правило. Проверено на PostgreSQL 16: строка 'pending' —
-- отказ и откат, без неё — ограничение стоит и проверено.
--
-- NULL колонка не допускает (NOT NULL с 040), поэтому IN без оговорки.
--
-- `rejected` в словаре нет: писателя у него нет, он остаётся только в
-- защитных WHERE (lib/bookings/occupancy.ts), где лишнее значение безвредно.
--
-- Новое значение в словарь — только вместе с миграцией, переставляющей это
-- ограничение. Сторожа: tests/unit/booking-status-check.test.ts (множество
-- значений CHECK последней миграции равно словарю, писатели пишут словарные),
-- tests/integration/booking-writers.pg.test.ts (каждое слово словаря
-- проходит, слово вне словаря — 23514, повтор миграции без ошибки).
--
-- Идемпотентно: ограничение добавляется, только если его нет; VALIDATE уже
-- проверенного ограничения ничего не делает.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'operator_bookings'::regclass
       AND conname  = 'operator_bookings_booking_status_check'
  ) THEN
    ALTER TABLE operator_bookings
      ADD CONSTRAINT operator_bookings_booking_status_check
      CHECK (booking_status IN ('new', 'confirmed', 'pending_payment', 'completed', 'cancelled', 'no_show'))
      NOT VALID;
  END IF;
END $$;

ALTER TABLE operator_bookings VALIDATE CONSTRAINT operator_bookings_booking_status_check;
