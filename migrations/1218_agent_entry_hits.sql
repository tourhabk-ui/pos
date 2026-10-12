-- 1218: перепись краулеров по семействам у входов для агентов.
--
-- Решение владельца 12.10 («го» на китайский слой для агентов): без счётчика
-- нельзя сказать, приходят ли Baidu, ByteDance и Huawei вообще — page_views
-- пишется браузерным скриптом, который обходчик не исполняет, middleware не
-- видит robots.txt и /.well-known/*, журнал MCP считает только вызовы
-- инструментов.
--
-- Сырой User-Agent и IP НЕ хранятся (та же граница, что у mcp_clients,
-- миграция 872): только семейство по реестру lib/analytics/bot-detect.ts,
-- путь входа и число запросов за сутки. Строка в сутки на (путь, семейство);
-- пишет lib/analytics/agent-entry-hits.ts, читает /api/cron/agent-entry-census.

CREATE TABLE IF NOT EXISTS agent_entry_hits (
  day    DATE    NOT NULL,
  path   TEXT    NOT NULL,
  family TEXT    NOT NULL,
  hits   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path, family)
);

COMMENT ON TABLE agent_entry_hits IS
  'Запросы к входам для агентов (robots.txt, llms.txt, манифесты MCP и A2A) по семействам ботов за сутки; User-Agent и IP не хранятся';
