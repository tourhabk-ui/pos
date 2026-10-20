/**
 * GET /.well-known/mcp.json — манифест обнаружения.
 *
 * Сервер у нас был (`/api/mcp`), а способа его НАЙТИ — нет: чужой агент должен
 * был заранее знать адрес. Манифест по общему пути — то, что превращает
 * «сервер существует» в «сервер находят».
 *
 * Список инструментов берётся из того же модуля, что отдаёт сам сервер
 * (lib/mcp/public-tools.ts). Обещать в манифесте то, чего в сервере нет, —
 * худший вид молчаливой лжи: агент строит план по манифесту и падает на вызове.
 */

import { NextResponse } from 'next/server';
import { PUBLIC_MCP_TOOLS, MCP_SERVER_INFO } from '@/lib/mcp/public-tools';
import { MCP_CATALOGS, MCP_TITLE_EN, MCP_DESCRIPTION_EN } from '@/lib/mcp/catalogs';
import { MCP_TITLE_ZH, MCP_DESCRIPTION_ZH } from '@/lib/mcp/zh-layer';
import { recordAgentEntryHit } from '@/lib/analytics/agent-entry-hits';
import { MCP_CONNECT_OPTIONS, MCP_SYSTEM_PROMPT_LINE_EN } from '@/lib/mcp/connect';
import { getPublicBaseUrl } from '@/lib/config';
import { AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH, A2A_JSONRPC_PATH, A2A_REST_PATH } from '@/lib/a2a/agent-card';
import { A2A_CATALOGS } from '@/lib/a2a/catalogs';
import { SERVER_CARD_PATH, AI_CATALOG_PATH } from '@/lib/mcp/server-card';
import { OPENAPI_PATH, API_CATALOG_PATH } from '@/lib/api/openapi';

export const dynamic = 'force-dynamic';

export async function GET(request?: Request) {
  // Перепись краулеров по семействам (12.10): кто читает манифест.
  recordAgentEntryHit('/.well-known/mcp.json', request?.headers.get('user-agent') ?? null);
  const base = getPublicBaseUrl().replace(/\/$/, '');

  return NextResponse.json(
    {
      ...MCP_SERVER_INFO,
      // Английские заголовок и описание — из server.json, того же текста, что
      // в реестре и Smithery: агент, пришедший из каталога, узнаёт запись.
      title: MCP_TITLE_EN,
      descriptionEn: MCP_DESCRIPTION_EN,
      // Китайский слой (12.10) — для чатов и поисковиков КНР, текст в lib/mcp/zh-layer.
      titleZh: MCP_TITLE_ZH,
      descriptionZh: MCP_DESCRIPTION_ZH,
      // Где мы числимся — чтобы «нет в каталоге» проверялось, а не гадалось.
      catalogs: MCP_CATALOGS,
      // Как добавить одним касанием и что сказать модели, чтобы она выбирала
      // нас внутри набора: агент, читающий манифест, может отдать это host'у.
      connect: Object.fromEntries(MCP_CONNECT_OPTIONS.map((o) => [o.id, o.value])),
      systemPromptHint: MCP_SYSTEM_PROMPT_LINE_EN,
      // Streamable HTTP: один URL, JSON-RPC 2.0 поверх POST.
      transport: 'streamable-http',
      endpoint: `${base}/api/mcp`,
      documentation: `${base}/llms.txt`,
      // Карточка сервера (расширение MCP Server Card) и каталог домена (AI
      // Catalog) — то, что агент читает до рукопожатия (12.10).
      serverCard: `${base}${SERVER_CARD_PATH}`,
      aiCatalog: `${base}${AI_CATALOG_PATH}`,
      // Для агентов без MCP и A2A (ступень 3, 12.10): описание OpenAPI 3.1 и
      // каталог API по RFC 9727 — агент из манифеста узнаёт и этот вход.
      openapi: `${base}${OPENAPI_PATH}`,
      apiCatalog: `${base}${API_CATALOG_PATH}`,
      // Тот же агент по A2A (12.10) — для клиентов без MCP: визитки обеих
      // версий и оба биндинга. Агент, прочитавший один манифест, узнаёт о другом.
      a2a: {
        agentCard: `${base}${AGENT_CARD_PATH}`,
        legacyAgentCard: `${base}${LEGACY_AGENT_CARD_PATH}`,
        jsonrpc: `${base}${A2A_JSONRPC_PATH}`,
        rest: `${base}${A2A_REST_PATH}`,
        // Где визитка числится — проверяется, а не гадается.
        // Запись a2aregistry ещё на проверке (страница 404) — ссылку не отдаём.
        catalogs: A2A_CATALOGS.map(({ url: _url, ...c }) => ({ ...c, listing: 'pending_review' })),
      },
      // Человекочитаемый первоисточник — для людей и поисковых AI-ответов.
      homepage: `${base}/mcp`,
      // Данные публичные, ключей не требуем — но и писать наружу нечего,
      // кроме заявки на подбор тура.
      authentication: 'none',
      capabilities: { tools: {} },
      tools: PUBLIC_MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
      contact: `${base}/contact`,
    },
    {
      headers: {
        // Манифест читают краулеры и чужие раннеры: пусть кэшируют, но не
        // навсегда — состав инструментов меняется вместе с платформой.
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}
