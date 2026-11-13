-- 1438: причина отказа задаче A2A — в журнале запросов.
--
-- Слово владельца 13.11: «посмотрел журнал запросов A2A… 2 запроса и попытка
-- бронирования, но были отклонены по причине нет согласия человека. Может,
-- согласие не доходит? Нужна проверка».
--
-- Журнал знал только состояние задачи — rejected. Отчего — не знал: под
-- таблицей стояла общая подпись «нет согласия, нет мест, лимит,
-- несуществующий инструмент», и какой из случаев перед глазами, по ней не
-- прочитать. Причина при этом уже называлась кодом отказа инструмента
-- (McpUserError.code: no_consent, bad_phone, invalid_args:<поле>, write_guard…),
-- но доходила только до журнала MCP.
--
-- Колонка — машинный код, не текст: ни слов агента, ни значений аргументов в
-- ней нет (lib/a2a/reject-reason, safeRejectCode). NULL — задача не отклонена
-- либо строка записана до этой миграции: прежним отказам причину взять
-- неоткуда, и она не выдумывается.
--
-- Пишет lib/a2a/journal.ts, читает /api/admin/analytics/a2a.

BEGIN;

ALTER TABLE a2a_requests
  ADD COLUMN IF NOT EXISTS reject_code VARCHAR(40) NULL;

DO $$
BEGIN
  -- Причина отказа — только у отклонённой задачи. IS NOT DISTINCT FROM, а не
  -- «=»: у строки без состояния (чтение визитки, ошибка протокола) сравнение
  -- с NULL дало бы «неизвестно», а CHECK пропускает неизвестное.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'a2a_requests_reject_code_only_rejected') THEN
    ALTER TABLE a2a_requests
      ADD CONSTRAINT a2a_requests_reject_code_only_rejected
      CHECK (reject_code IS NULL OR state IS NOT DISTINCT FROM 'rejected');
  END IF;
  -- Код, а не текст: свои знаки и не пусто.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'a2a_requests_reject_code_shape') THEN
    ALTER TABLE a2a_requests
      ADD CONSTRAINT a2a_requests_reject_code_shape
      CHECK (reject_code IS NULL OR reject_code ~ '^[a-z0-9_]{1,24}(:[a-z0-9_]{1,20})?$');
  END IF;
END $$;

COMMENT ON COLUMN a2a_requests.reject_code IS
  'Причина отказа задаче (state = rejected) машинным кодом: no_consent, bad_phone, invalid_args:<поле>, write_guard, rate_limited, unknown_tool… NULL — не отклонена или записана до 1438';

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE a2a_requests
--   DROP CONSTRAINT IF EXISTS a2a_requests_reject_code_shape,
--   DROP CONSTRAINT IF EXISTS a2a_requests_reject_code_only_rejected,
--   DROP COLUMN IF EXISTS reject_code;
-- COMMIT;
