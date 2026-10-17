/**
 * GET /.well-known/mcp — алиас манифеста /.well-known/mcp.json: часть клиентов
 * ищет путь без расширения. Тот же обработчик, тот же ответ.
 */
export { GET } from '../mcp.json/route';

export const dynamic = 'force-dynamic';
