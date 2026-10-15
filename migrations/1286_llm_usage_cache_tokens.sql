-- 1286: кэш подсказок в книгах расхода — запись в кэш и чтение из него
--
-- Аудит 15.10, находка AC-1, решение «б» по карт-бланшу владельца: расход
-- «рук» (claude-code-action в claude.yml, issue-triage, ci-sweeper,
-- weekly-chronicle) доходит до llm_usage_log через
-- POST /api/admin/llm-usage/report.
--
-- Рукам мало входа и выхода. По разбору счёта Anthropic 21.08–19.09
-- (CLAUDE.md §5.1) 70% денег — кэш: запись в него дороже обычного входа,
-- чтение дешевле, но токенов чтения у агентского прогона — миллионы. Книги без
-- кэша занизили бы расход рук в разы, и дневной бюджет
-- (/api/cron/llm-budget-check) складывал бы не то, что тратится.
--
-- Колонки:
--   cache_creation_tokens — записано в кэш подсказок за вызов (прогон руки);
--   cache_read_tokens     — прочитано из кэша.
-- Обе NULLABLE и без умолчания: NULL — источник кэш не сообщал (все прежние
-- строки и все звонящие, кроме рук), 0 — сообщил, что кэша не было. Ноль по
-- умолчанию выдал бы «не знаем» за «кэша не было» (§4.0).
--
-- total_tokens смысла не меняет: вход + выход, как с миграции 686. Кэш — в
-- своих колонках, а его ЦЕНА входит в estimated_cost_usd (считает сервер,
-- lib/ai/cache-pricing.ts). Задним числом ничего не пересчитывается.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS, ограничения — по наличию. Без
-- BEGIN/COMMIT: транзакцию даёт раннер миграций.

ALTER TABLE llm_usage_log
  ADD COLUMN IF NOT EXISTS cache_creation_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS cache_read_tokens     INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'llm_usage_log_cache_tokens_nonneg'
       AND conrelid = 'llm_usage_log'::regclass
  ) THEN
    ALTER TABLE llm_usage_log
      ADD CONSTRAINT llm_usage_log_cache_tokens_nonneg
      CHECK (
        (cache_creation_tokens IS NULL OR cache_creation_tokens >= 0)
        AND (cache_read_tokens IS NULL OR cache_read_tokens >= 0)
      );
  END IF;
END $$;

COMMENT ON COLUMN llm_usage_log.cache_creation_tokens IS
  'Записано в кэш подсказок за вызов. NULL — источник кэш не сообщал (не ноль). Цена записи входит в estimated_cost_usd: 1,25 цены входа у Anthropic (5-минутный кэш), lib/ai/cache-pricing.ts. В total_tokens не входит.';
COMMENT ON COLUMN llm_usage_log.cache_read_tokens IS
  'Прочитано из кэша подсказок за вызов. NULL — источник кэш не сообщал (не ноль). Цена чтения входит в estimated_cost_usd: 0,1 цены входа у Anthropic, lib/ai/cache-pricing.ts. В total_tokens не входит.';
