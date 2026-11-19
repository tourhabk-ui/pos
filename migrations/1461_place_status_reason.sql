-- Migration 1461: причина жёлтого статуса места — межсезонное закрытие парка (#3487)
-- Created: 2026-11-19
--
-- Слово владельца 19.11 «go» (вариант 3.1 разбора #3487): не красить место
-- красным для выезда оператора по его зимнему календарю, но закрытие троп
-- парка показывать.
--
-- Карточка Авачинского перевала 17.11 писала «Сегодня там опасно»: место
-- красилось закрытием туристических маршрутов природных парков на
-- межсезонье, а зимние туры туда идут по календарю оператора. Закрытие на
-- межсезонье закрывает тропы парка до сезона; опасности дня оно не называет.
--
-- Пересчёт статуса (safety-ingest, updateRealTimeStatus) теперь красит такое
-- место жёлтым и пишет причину сюда. Оперативное закрытие (циклон, пожар,
-- медведи — любое слово опасности в тексте) остаётся красным. Правило —
-- `isSeasonalClosure` (lib/safety/park-closure.ts).
--
-- NULL — у цвета нет записанной причины (все прочие ветки пересчёта).
-- Причину читатель принимает только при жёлтом цвете (placeDayStatus): CHECK
-- держит лишь словарь, чтобы будущий писатель цвета не падал на ограничении.
-- Колонку заполнит первый пересчёт после выката; до него все строки NULL —
-- так и было.

ALTER TABLE location_real_time_status
  ADD COLUMN IF NOT EXISTS status_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'location_real_time_status_reason_check'
  ) THEN
    ALTER TABLE location_real_time_status
      ADD CONSTRAINT location_real_time_status_reason_check
      CHECK (status_reason IS NULL OR status_reason = 'park_season');
  END IF;
END $$;

COMMENT ON COLUMN location_real_time_status.status_reason IS
  'Причина цвета, записанная пересчётом safety-ingest: park_season — тропы парка закрыты на межсезонье (жёлтый, #3487). NULL — причина не записана.';

-- Rollback:
-- ALTER TABLE location_real_time_status DROP CONSTRAINT IF EXISTS location_real_time_status_reason_check;
-- ALTER TABLE location_real_time_status DROP COLUMN IF EXISTS status_reason;
