/**
 * GET /.well-known/ard.json — манифест ARD (Agentic Resource Discovery,
 * agenticresourcediscovery.org/spec): путь, который потребитель обязан
 * прочитать (§5.1). Преемник /.well-known/ai-catalog.json, документ тот же
 * (lib/mcp/server-card, buildAiCatalog). Его же проверяет «Агентный
 * просмотр» Lighthouse 13 (аудит ard-schema).
 */

import { ARD_MEDIA_TYPE, ARD_PATH } from '@/lib/mcp/server-card';
import { catalogResponse, catalogOptions } from '@/lib/mcp/ai-catalog-response';
import { recordAgentEntryHit } from '@/lib/analytics/agent-entry-hits';

export const dynamic = 'force-dynamic';

export async function GET(request?: Request) {
  // Перепись краулеров по семействам: кто читает манифест ARD.
  recordAgentEntryHit(ARD_PATH, request?.headers.get('user-agent') ?? null);
  return catalogResponse(request, ARD_MEDIA_TYPE);
}

export async function OPTIONS() {
  return catalogOptions();
}
