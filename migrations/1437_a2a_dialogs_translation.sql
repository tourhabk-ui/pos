-- 1437: перевод реплик журнала общения A2A на русский.
--
-- Слово владельца 13.11: «посмотрел журнал A2A за сегодня — нужно кнопку в
-- журнал добавить перевести, много китайцев подключилось». Вопросы агентов и
-- часть ответов Кузьмича лежат в журнале по-китайски и по-английски, и читать
-- их администратору нечем.
--
-- Перевод хранится В ТОЙ ЖЕ строке, что исходник:
--   · у него тот же срок (90 суток) и та же уборка — отдельной таблицы,
--     которая пережила бы исходник, нет;
--   · переведённое один раз не переводится заново при каждом открытии
--     страницы — модель стоит денег;
--   · исходник не меняется: перевод показывается рядом с пометкой «машинный».
--
-- NULL — перевода нет: поле по-русски, перевод не запрашивали или модель не
-- справилась. Пустая строка переводом не бывает (CHECK).
--
-- Переводится текст ПОСЛЕ redactPII — тот, что уже лежит в question и answer.
-- Пишет lib/a2a/dialog-translate.ts (кнопка на /hub/admin/a2a), читает
-- /api/admin/analytics/a2a (блок dialogs).

BEGIN;

ALTER TABLE a2a_dialogs
  ADD COLUMN IF NOT EXISTS question_ru       TEXT        NULL,
  ADD COLUMN IF NOT EXISTS answer_ru         TEXT        NULL,
  -- когда сделан последний перевод строки и каким путём водопада
  ADD COLUMN IF NOT EXISTS translated_at     TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS translation_model VARCHAR(40) NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'a2a_dialogs_question_ru_not_blank') THEN
    ALTER TABLE a2a_dialogs
      ADD CONSTRAINT a2a_dialogs_question_ru_not_blank CHECK (question_ru IS NULL OR btrim(question_ru) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'a2a_dialogs_answer_ru_not_blank') THEN
    ALTER TABLE a2a_dialogs
      ADD CONSTRAINT a2a_dialogs_answer_ru_not_blank CHECK (answer_ru IS NULL OR btrim(answer_ru) <> '');
  END IF;
  -- Перевод без отметки «когда и чем» не пишется.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'a2a_dialogs_translation_stamped') THEN
    ALTER TABLE a2a_dialogs
      ADD CONSTRAINT a2a_dialogs_translation_stamped CHECK (
        (question_ru IS NULL AND answer_ru IS NULL)
        OR (translated_at IS NOT NULL AND translation_model IS NOT NULL)
      );
  END IF;
END $$;

COMMENT ON COLUMN a2a_dialogs.question_ru IS
  'Машинный перевод вопроса на русский (lib/a2a/dialog-translate); NULL — перевода нет';
COMMENT ON COLUMN a2a_dialogs.answer_ru IS
  'Машинный перевод ответа на русский (lib/a2a/dialog-translate); NULL — перевода нет';

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE a2a_dialogs
--   DROP CONSTRAINT IF EXISTS a2a_dialogs_translation_stamped,
--   DROP CONSTRAINT IF EXISTS a2a_dialogs_answer_ru_not_blank,
--   DROP CONSTRAINT IF EXISTS a2a_dialogs_question_ru_not_blank,
--   DROP COLUMN IF EXISTS translation_model,
--   DROP COLUMN IF EXISTS translated_at,
--   DROP COLUMN IF EXISTS answer_ru,
--   DROP COLUMN IF EXISTS question_ru;
-- COMMIT;
