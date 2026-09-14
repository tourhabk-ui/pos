-- Migration 961: estimated_cost_usd — NULL значит «не знаем», не «бесплатно» (#1862)
--
-- `NUMERIC(10,6) NOT NULL DEFAULT 0` (миграция 686) не умеет сказать «цену не
-- знаем» — тип принуждает выдумать (§4.0 дословно). `logLLMUsage`
-- (lib/ai/providers.ts) считала цену по захардкоженной COST_PER_1K на 18
-- строк, и ни одной модели, которая реально работает сегодня — deepseek-v4-pro
-- (7 вердиктов судьи из 8), deepseek-v4-flash, z-ai/glm-5.3 (флагман с
-- 09.09), grok-4.6, qwen-vl — в ней не было. Каждая живая строка журнала
-- считалась умолчанием $0.0005: втрое завышала дешёвую модель, втрое с
-- половиной занижала дорогую — на том самом выборе, ради которого счёт
-- читают.
--
-- Правка кода берёт цену из model_catalog (миграция 946, цены OpenRouter,
-- привезённые раннером) и пишет NULL при промахе — токены остаются фактом
-- всегда, цена нет. Эта миграция даёт колонке право на NULL.
--
-- Решение владельца 14.09 (карт-бланш) — что делать с историей: «пересчёт
-- задним числом — тоже вид выдумывания». Прошлые строки НЕ пересчитываются
-- по каталогу — они остаются такими же неточными, какими были, но теперь
-- честно помечены источником, а не выдаются за посчитанные по-новому.
-- cost_basis несёт эту метку на каждой строке, а не в комментарии, который
-- устареет молча.
--
-- IDEMPOTENT

BEGIN;

ALTER TABLE llm_usage_log ALTER COLUMN estimated_cost_usd DROP NOT NULL;
ALTER TABLE llm_usage_log ALTER COLUMN estimated_cost_usd DROP DEFAULT;

ALTER TABLE llm_usage_log ADD COLUMN IF NOT EXISTS cost_basis TEXT;

-- Перелом — дата этой миграции, зафиксированная в самой метке: пересчёта
-- задним числом не будет, а «когда именно» не должно зависеть от памяти о
-- том, когда её накатили.
UPDATE llm_usage_log SET cost_basis = 'legacy_default_guess_2026-09-14'
  WHERE cost_basis IS NULL;

COMMENT ON COLUMN llm_usage_log.estimated_cost_usd IS
  'NULL — цену модели не знаем (её нет ни в каталоге OpenRouter, ни в запасной таблице для прямых провайдеров). 0 — модель бесплатна, это факт, не пробел. Не путать: SUM(...) в SQL молча пропускает NULL — считать «сколько строк с неизвестной ценой» отдельным COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL).';
COMMENT ON COLUMN llm_usage_log.cost_basis IS
  'Источник цены: model_catalog (OpenRouter, миграция 946) / cost_table_fallback (COST_PER_1K в lib/ai/providers.ts — прямые провайдеры вне каталога) / unknown (не нашли нигде, estimated_cost_usd NULL) / legacy_default_guess_2026-09-14 (строки до этой миграции — старое умолчание $0.0005, не пересчитаны).';

COMMIT;
