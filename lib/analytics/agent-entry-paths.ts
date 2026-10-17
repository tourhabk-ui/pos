/**
 * Входы для агентов, у которых считаются запросы (перепись краулеров по
 * семействам, 12.10). Отдельный модуль без базы: его читает и счётчик
 * (lib/analytics/agent-entry-hits, пишет), и перепись
 * (/api/cron/agent-entry-census, только читает) — перепись не должна тянуть
 * за списком путей модуль с INSERT, иначе реестр возможностей
 * (cron-capability-registry) честно припишет ей db_write.
 *
 * С аудита 15.10 (CN-quick) в счёт входят sitemap и китайский вход /zh: до
 * этого дня ответить, читали ли Baiduspider, YisouSpider (поиск Alibaba, им
 * отвечает Qwen) или Bytespider китайскую страницу, было нечем — счётчик
 * видел только машинные файлы. Остальные HTML-страницы перепись по-прежнему
 * называет несчитаемыми вслух (NOT_COUNTED).
 */
export const AGENT_ENTRY_PATHS = [
  '/robots.txt',
  '/llms.txt',
  // 17.10: китайский llms-файл. Своей строкой, а не вместе с /llms.txt:
  // вопрос, ради которого заведён китайский слой, — ходят ли китайские
  // агенты, — отвечается только раздельным счётом.
  '/llms-zh.txt',
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
  // 15.10 (аудит, CN-quick): карта сайта — то, с чего обходчик поисковика
  // узнаёт о /zh, и сама китайская страница.
  '/sitemap.xml',
  '/zh',
  // Одна метка на весь раздел /zh/<…> (китайские конспекты /zh/tours/<адрес>
  // и /zh/places/<адрес>, аудит 15.10, CN-pages): строка на раздел, а не путь
  // на каждую карточку. Метку ставит zhEntryPath() внутри recordZhEntryHit —
  // той же функции, что зовёт /zh. Индексируются только конспекты с
  // переводом (lib/zh/content), поэтому ноль до первых переводов значит
  // «искать пока нечего», а не «не ходят».
  '/zh/*',
] as const;

export type AgentEntryPath = (typeof AGENT_ENTRY_PATHS)[number];

/**
 * HTML-страницы среди входов: здесь не считаются браузеры людей. Счётчик —
 * перепись обходчиков, а не посещаемость; людей считает page_views, и второй
 * счёт тех же людей разошёлся бы с первым. Обходчик, назвавшийся по реестру
 * семейств, инструмент, пустой и неопознанный заголовок — считаются.
 */
export const AGENT_ENTRY_HTML_PATHS: ReadonlySet<AgentEntryPath> = new Set<AgentEntryPath>(['/zh', '/zh/*']);

/**
 * Метка входа для адреса китайского раздела: сам /zh — своей строкой, всё
 * под ним — одной меткой /zh/*. Не китайский адрес — null: считать его
 * здесь нечем, и подставлять чужую метку нельзя.
 */
export function zhEntryPath(pathname: string): AgentEntryPath | null {
  const p = pathname.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  if (p === '/zh') return '/zh';
  if (p.startsWith('/zh/')) return '/zh/*';
  return null;
}
