-- Migration 1435: кто закрыл дату тура — признак «закрыл Ведар» (план «после отказа», этап 6)
-- Created: 2026-11-12
--
-- 1421 закрыла зимние даты пяти туров «Лагуны Экспедиции» по ОЦЕНКЕ платформы
-- («зимой тур по его описанию под вопросом»), а не по слову оператора. В
-- данных это закрытие неотличимо от стоп-продажи: тот же is_cancelled, разница
-- — только слова в cancellation_reason. Поэтому каждая дверь отвечала о нём
-- неправдой: форма сайта — «Оператор закрыл приём заявок на эту дату» (он не
-- закрывал), ИИ-агенту — «нет свободных мест» (их никто не занимал), и человек
-- уходил с «предложите другой тур», хотя оператора никто не спросил.
--
-- closed_by = 'platform' — дату закрыл Ведар по оценке, оператор её не
-- подтверждал и не закрывал. NULL — закрыл оператор, гид или администратор за
-- него, либо дата не закрыта: «кто именно из них» система не записывает и не
-- выдумывает. Значение 'operator' не заводится: производителя у него нет.
--
-- Признак держит база, а не каждый писатель: закрытие дат пишут пять мест
-- (календарь оператора, стоп-продажа, чат гида, чат оператора, кабинет), и
-- ни одно о колонке не знает. Триггер: правка закрытия (is_cancelled или
-- причина), которая сама не ставит closed_by, признак стирает — оператор
-- открыл дату или закрыл её своими словами, и оценка Ведара больше не при чём.
--
-- Заполнение — по причине 1421 слово в слово, только у закрытых живых строк.
--
-- Идемпотентна: IF NOT EXISTS, CREATE OR REPLACE, повтор UPDATE ничего не меняет.

BEGIN;

ALTER TABLE tour_availability ADD COLUMN IF NOT EXISTS closed_by TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tour_availability_closed_by_check') THEN
    ALTER TABLE tour_availability
      ADD CONSTRAINT tour_availability_closed_by_check CHECK (closed_by IS NULL OR closed_by = 'platform');
  END IF;
  -- Признак — только у закрытой даты.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tour_availability_closed_by_closed') THEN
    ALTER TABLE tour_availability
      ADD CONSTRAINT tour_availability_closed_by_closed CHECK (closed_by IS NULL OR is_cancelled IS TRUE);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION tour_availability_closed_by_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.closed_by IS NOT DISTINCT FROM OLD.closed_by
     AND (NEW.is_cancelled IS DISTINCT FROM OLD.is_cancelled
          OR NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason) THEN
    NEW.closed_by := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_tour_availability_closed_by ON tour_availability;
CREATE TRIGGER trigger_tour_availability_closed_by
  BEFORE UPDATE ON tour_availability
  FOR EACH ROW EXECUTE FUNCTION tour_availability_closed_by_guard();

-- Закрытое 1421 — закрыл Ведар. Правка меняет только closed_by: триггер её не трогает.
UPDATE tour_availability
   SET closed_by = 'platform'
 WHERE is_cancelled IS TRUE AND deleted_at IS NULL AND closed_by IS NULL
   AND cancellation_reason = 'Закрыто Ведаром: зимой тур по его описанию под вопросом (1421). Если тур ходит — откройте даты.';

COMMENT ON COLUMN tour_availability.closed_by IS
  'Кто закрыл дату: platform — Ведар по оценке (оператор не подтверждал); NULL — оператор, гид, администратор или дата не закрыта. Правка закрытия без нового признака его стирает (триггер).';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TRIGGER IF EXISTS trigger_tour_availability_closed_by ON tour_availability;
-- DROP FUNCTION IF EXISTS tour_availability_closed_by_guard();
-- ALTER TABLE tour_availability DROP CONSTRAINT IF EXISTS tour_availability_closed_by_closed;
-- ALTER TABLE tour_availability DROP CONSTRAINT IF EXISTS tour_availability_closed_by_check;
-- ALTER TABLE tour_availability DROP COLUMN IF EXISTS closed_by;
-- COMMIT;
