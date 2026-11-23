-- 1510: где потрачен расход LLM — на сайте или на раннере GitHub.
--
-- Слово владельца 23.11 «1 да»: суточный стоп расходов считает только расход
-- сайта. 23.11 стоп закрылся на $7,60 при пороге $5, а $7,02 из них дала
-- проверка безопасности PR на раннере GitHub. Кузьмич замолчал для туристов
-- из-за трат, к которым туристы отношения не имеют.
--
-- Различить строки было нечем: и сайт (lib/ai/providers.ts, logLLMUsage), и
-- приём расхода раннера (POST /api/admin/llm-usage/report) пишут в `route`
-- имя модели. Колонка заводится здесь.
--
-- Новые строки — 'prod' по умолчанию: так пишут сайт и прямой INSERT
-- /api/ai/deepseek. Приём раннера пишет 'runner' сам, явно.
-- Прежние строки остаются NULL — «где потрачено, не записано». Задним числом
-- их не размечаем: по `route` и `agent_id` раннер от сайта не отличить
-- надёжно. Стоп считает NULL вместе с сайтом, как считал до этого дня.
--
-- Порядок важен: колонка заводится БЕЗ умолчания, и только потом ставится
-- умолчание. ADD COLUMN ... DEFAULT 'prod' записал бы 'prod' и во все
-- прежние строки, в том числе в расход раннера.
--
-- Повторный прогон ничего не меняет.

ALTER TABLE llm_usage_log ADD COLUMN IF NOT EXISTS spent_where TEXT;

ALTER TABLE llm_usage_log ALTER COLUMN spent_where SET DEFAULT 'prod';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'llm_usage_log_spent_where_check'
  ) THEN
    ALTER TABLE llm_usage_log
      ADD CONSTRAINT llm_usage_log_spent_where_check
      CHECK (spent_where IS NULL OR spent_where IN ('prod', 'runner'));
  END IF;
END $$;

COMMENT ON COLUMN llm_usage_log.spent_where IS
  'Где потрачено: prod — сайт, runner — раннер GitHub (приём /api/admin/llm-usage/report). NULL — строка до миграции 1510, место не записано. Суточный стоп считает всё, кроме runner.';
