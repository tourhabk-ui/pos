-- 705_agent_run_llm_usage.sql
-- Атрибуция LLM-затрат по агенту (Roitman §18.7.4, триада наблюдаемости —
-- latency/duration уже были в agent_run_history, токенов и стоимости не
-- было). При ~40 cron-агентах нельзя было ответить "кто сжёг бюджет вчера".
-- Семантика llm_usage_log.route (model id) не меняется — agent_id отдельная
-- новая колонка, NULL вне агентного контекста (обычные HTTP-запросы Кузьмича).

ALTER TABLE llm_usage_log ADD COLUMN IF NOT EXISTS agent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_llm_usage_agent_day ON llm_usage_log (agent_id, created_at);

ALTER TABLE agent_run_history ADD COLUMN IF NOT EXISTS prompt_tokens INT;
ALTER TABLE agent_run_history ADD COLUMN IF NOT EXISTS completion_tokens INT;
ALTER TABLE agent_run_history ADD COLUMN IF NOT EXISTS llm_calls INT;
ALTER TABLE agent_run_history ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC(10,6);
