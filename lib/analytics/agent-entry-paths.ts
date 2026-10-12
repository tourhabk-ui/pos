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
] as const;

export type AgentEntryPath = (typeof AGENT_ENTRY_PATHS)[number];
