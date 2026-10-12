/**
 * Входы для агентов, у которых считаются запросы (перепись краулеров по
 * семействам, 12.10). Отдельный модуль без базы: его читает и счётчик
 * (lib/analytics/agent-entry-hits, пишет), и перепись
 * (/api/cron/agent-entry-census, только читает) — перепись не должна тянуть
 * за списком путей модуль с INSERT, иначе реестр возможностей
 * (cron-capability-registry) честно припишет ей db_write.
 *
 * HTML-страницы и sitemap сюда не входят — перепись называет это вслух.
 */
export const AGENT_ENTRY_PATHS = [
  '/robots.txt',
  '/llms.txt',
  '/.well-known/mcp.json',
  '/.well-known/agent-card.json',
  '/.well-known/agent.json',
  // 12.10: карточка MCP-сервера и каталог домена (lib/mcp/server-card).
  '/api/mcp/server-card',
  '/.well-known/ai-catalog.json',
  // 12.10, ступень 3: описание OpenAPI 3.1 для агентов без MCP и A2A и каталог
  // API по RFC 9727 (lib/api/openapi).
  '/openapi.json',
  '/.well-known/api-catalog',
] as const;

export type AgentEntryPath = (typeof AGENT_ENTRY_PATHS)[number];
