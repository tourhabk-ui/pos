/**
 * GET /.well-known/ai-catalog.json — AI Catalog домена (Linux Foundation,
 * Agent-Card/ai-catalog): один список всего, что у нас есть для агентов —
 * карточка MCP-сервера и визитки A2A обеих версий, каждая со своим медиатипом
 * и адресом. Агент, нашедший домен, читает этот файл и дальше идёт по ссылкам.
 *
 * Прежнее имя каталога: преемник — /.well-known/ard.json (ARD §5.1), тот же
 * документ. Этот путь остаётся для агентов, которые уже его читают.
 *
 * Содержимое — lib/mcp/server-card (из server.json и констант A2A), чтобы
 * имена и версии не расходились с реестром и визитками. Медиатип
 * application/ai-catalog+json, час кэша, ETag с 304, CORS на чтение.
 */

import { AI_CATALOG_MEDIA_TYPE, AI_CATALOG_PATH } from '@/lib/mcp/server-card';
import { catalogResponse, catalogOptions } from '@/lib/mcp/ai-catalog-response';
import { recordAgentEntryHit } from '@/lib/analytics/agent-entry-hits';

export const dynamic = 'force-dynamic';

export async function GET(request?: Request) {
  // Перепись краулеров по семействам: кто читает каталог домена.
  recordAgentEntryHit(AI_CATALOG_PATH, request?.headers.get('user-agent') ?? null);
  return catalogResponse(request, AI_CATALOG_MEDIA_TYPE);
}

export async function OPTIONS() {
  return catalogOptions();
}
