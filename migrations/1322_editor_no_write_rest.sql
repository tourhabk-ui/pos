-- 1322: отдых записи, которую Editor не описал (23.10, ревью ужесточения
-- Editor; владелец: «Editor много выдумал его ужесточить промтном»).
--
-- После ужесточения у Editor два исхода «не записал» без поломки: модель
-- ответила «НЕТ» (из фактов нечего написать) или текст не прошёл проверку
-- правды. Ни тот, ни другой ничего не меняют в строке: ни описания, ни
-- updated_at, ни записи журнала 911. Очередь (`editorQueueWhereSql`) брала
-- такую строку снова на КАЖДОМ прогоне — раннер в 21:40 и прод в 22:00, — и
-- каждую ночь платила вызов модели за почти тот же ответ при температуре 0.2.
-- REATTEMPT_REST_DAYS заводили ровно против такой петли, а пустые описания
-- отдыха не имели вовсе.
--
-- Журнал происхождения (911) для этого не годится: его последняя запись
-- решает подпись «написала модель» на карточке, и строка «отказался» в нём
-- спрятала бы происхождение текста, который уже стоит.
--
-- Производители — runEditor (прод) и /api/cron/editor-result (раннер присылает
-- id отказов, приёмник пишет и отказы проверки правды). Потребитель — условие
-- очереди: запись с отметкой моложе REATTEMPT_REST_DAYS не берётся.
-- Одна строка на запись: важна последняя попытка, история — в agent_runs.

CREATE TABLE IF NOT EXISTS editor_no_write (
  entity_id     UUID        PRIMARY KEY,
  entity_kind   TEXT        NOT NULL,
  outcome       TEXT        NOT NULL CHECK (outcome IN ('declined', 'truth_rejected')),
  reason        TEXT        NOT NULL,
  attempted_by  TEXT        NOT NULL,
  facts_count   INT         NOT NULL DEFAULT 0,
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_editor_no_write_attempted_at
  ON editor_no_write (attempted_at DESC);
