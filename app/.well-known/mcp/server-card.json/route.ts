/**
 * GET /.well-known/mcp/server-card.json — алиас карточки MCP-сервера
 * (/api/mcp/server-card). Часть клиентов и каталогов (черновик SEP-1649)
 * ищет карточку под /.well-known, без знания адреса MCP — без алиаса им 404,
 * и «найти Ведар без ручного подключения» ломается на первом шаге.
 */
export { GET, OPTIONS } from '../../../api/mcp/server-card/route';

export const dynamic = 'force-dynamic';
