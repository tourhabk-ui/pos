-- 1511: кто предложил поле правки тура — владелец или автомат платформы.
-- Created: 2026-11-23
--
-- ── Повод ─────────────────────────────────────────────────────────────────
--
-- Слово владельца 23.11: «Автоматы (кроны описаний и фото, импортёры) пишут
-- в туры только через очередь проверки, своих обходных путей у них нет».
--
-- До этого дня автоматы меняли описание, снимки и цену тура прямым UPDATE
-- живой строки — мимо очереди, заведённой миграцией 1507. Теперь автомат
-- кладёт правку в тот же черновик той же дверью, что владелец. Черновик у
-- тура один (индекс 1507), поэтому в нём могут оказаться и поля владельца, и
-- поля автомата. Чтобы администратор и владелец видели, чьё это предложение,
-- рядом с правкой хранится пометка: {колонка тура: имя автомата}.
--
-- Ключа нет — поле прислал владелец. Список автоматов держит код
-- (lib/tours/automaton, TOUR_AUTOMATA).
--
-- ── Существующие строки ───────────────────────────────────────────────────
--
-- Все прежние черновики получают пустую пометку: их присылали владельцы, и
-- это правда. Ни одна строка operator_tours не меняется.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; ограничение — через проверку каталога.

BEGIN;

ALTER TABLE operator_tour_edits
  ADD COLUMN IF NOT EXISTS proposed_by JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'operator_tour_edits_proposed_by_object'
  ) THEN
    ALTER TABLE operator_tour_edits
      ADD CONSTRAINT operator_tour_edits_proposed_by_object
      CHECK (jsonb_typeof(proposed_by) = 'object');
  END IF;
END $$;

COMMENT ON COLUMN operator_tour_edits.proposed_by IS
  'Кто предложил поле правки (1511): {колонка тура: имя автомата}. Ключа нет — поле прислал владелец';

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE operator_tour_edits DROP CONSTRAINT IF EXISTS operator_tour_edits_proposed_by_object;
-- ALTER TABLE operator_tour_edits DROP COLUMN IF EXISTS proposed_by;
-- COMMIT;
