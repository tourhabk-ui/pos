-- Migration 1458: правила целостности броней и заявок в самой базе (#3388 п.3)
-- Created: 2026-11-16
--
-- ── Основание ─────────────────────────────────────────────────────────────
--
-- Аудит схемы #3388, п.3; порядок пунктов — слово владельца 15.11 «3388»,
-- карт-бланш 16.11. Сначала данные проверены отчётом: перепись
-- GET /api/cron/booking-integrity-census (lib/bookings/integrity-census.ts),
-- проверка прода, прогон 192, 16.11.2026 11:11 UTC. Броней 5, заявок 0;
-- нарушений ни одного правила ниже нет. Поэтому VALIDATE пройдёт: строка,
-- нарушающая правило, остановила бы файл и весь накат после него.
--
-- ── Что ставится ──────────────────────────────────────────────────────────
--
--  1. Взрослых и детей не меньше нуля.
--  2. Взрослые и дети вместе — столько, сколько людей в брони, когда записаны
--     оба числа. Две двери могли это нарушить и поправлены в том же PR:
--     ручная бронь оператора теперь сверяет сумму (422 словами), перенос
--     брони с другим числом людей стирает разбивку (не знаем, кто добавился).
--  3. Дата окончания не раньше даты начала.
--  4. Отменённая бронь не возвращается в работу — триггер: её место уже
--     освобождено и могло уйти другому. Единственная дверь, которая это
--     позволяла, PUT /api/operator/bookings/[id], теперь отвечает 409 словами;
--     триггер держит правило за всех будущих писателей.
--  5. Размер группы в заявке больше нуля, если записан.
--
-- «Число людей больше нуля» база держит с baseline (participants_valid).
--
-- ── Что НЕ ставится, и почему ─────────────────────────────────────────────
--
--  - «дата тура не в прошлом»: ручная бронь оператора и гида законно
--    заводится задним числом, а CHECK с текущей датой сам становится
--    ложным со временем;
--  - «один человек — одна бронь на тур и дату»: уникальным индексом в базе не
--    ставится. Ручная бронь оператора и перепродавцы через OCTO законно пишут
--    один контакт на две группы, а аккаунта у таких броней нет. Запрет есть —
--    по слову владельца 16.11 «да» он стоит в общей двери брони туриста
--    (reserveBooking, lib/bookings/reserve.ts) и судит по аккаунту, не по
--    почте или телефону: по чужому контакту отказ выдал бы, что у того
--    человека есть бронь.
--
-- Идемпотентно: ограничение добавляется, только если его нет (NOT VALID, затем
-- VALIDATE, как 1291); функция и триггер пересоздаются.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'operator_bookings'::regclass
                    AND conname  = 'operator_bookings_parts_not_negative') THEN
    ALTER TABLE operator_bookings
      ADD CONSTRAINT operator_bookings_parts_not_negative
      CHECK (adult_count >= 0 AND child_count >= 0)
      NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'operator_bookings'::regclass
                    AND conname  = 'operator_bookings_parts_sum') THEN
    ALTER TABLE operator_bookings
      ADD CONSTRAINT operator_bookings_parts_sum
      CHECK (adult_count IS NULL OR child_count IS NULL OR adult_count + child_count = participants)
      NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'operator_bookings'::regclass
                    AND conname  = 'operator_bookings_end_not_before_start') THEN
    ALTER TABLE operator_bookings
      ADD CONSTRAINT operator_bookings_end_not_before_start
      CHECK (end_date IS NULL OR end_date >= booking_date)
      NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'leads'::regclass
                    AND conname  = 'leads_group_size_positive') THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_group_size_positive
      CHECK (group_size IS NULL OR group_size > 0)
      NOT VALID;
  END IF;
END $$;

ALTER TABLE operator_bookings VALIDATE CONSTRAINT operator_bookings_parts_not_negative;
ALTER TABLE operator_bookings VALIDATE CONSTRAINT operator_bookings_parts_sum;
ALTER TABLE operator_bookings VALIDATE CONSTRAINT operator_bookings_end_not_before_start;
ALTER TABLE leads VALIDATE CONSTRAINT leads_group_size_positive;

-- Отменённая бронь не возвращается в работу. Код ошибки — check_violation
-- (23514), как у CHECK: двери отвечают на него одинаково.
CREATE OR REPLACE FUNCTION operator_bookings_cancelled_is_final()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.booking_status = 'cancelled' AND NEW.booking_status IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'Отменённая бронь % не возвращается в работу', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_operator_bookings_cancelled_is_final ON operator_bookings;
CREATE TRIGGER trg_operator_bookings_cancelled_is_final
  BEFORE UPDATE OF booking_status ON operator_bookings
  FOR EACH ROW
  WHEN (OLD.booking_status = 'cancelled')
  EXECUTE FUNCTION operator_bookings_cancelled_is_final();

-- Rollback:
-- DROP TRIGGER IF EXISTS trg_operator_bookings_cancelled_is_final ON operator_bookings;
-- DROP FUNCTION IF EXISTS operator_bookings_cancelled_is_final();
-- ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_group_size_positive;
-- ALTER TABLE operator_bookings DROP CONSTRAINT IF EXISTS operator_bookings_end_not_before_start;
-- ALTER TABLE operator_bookings DROP CONSTRAINT IF EXISTS operator_bookings_parts_sum;
-- ALTER TABLE operator_bookings DROP CONSTRAINT IF EXISTS operator_bookings_parts_not_negative;
