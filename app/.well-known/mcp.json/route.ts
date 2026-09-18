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
import { MCP_CONNECT_OPTIONS, MCP_SYSTEM_PROMPT_LINE_EN } from '@/lib/mcp/connect';
import { getPublicBaseUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  const base = getPublicBaseUrl().replace(/\/$/, '');

  return NextResponse.json(
    {
      ...MCP_SERVER_INFO,
      // Английские заголовок и описание — из server.json, того же текста, что
      // в реестре и Smithery: агент, пришедший из каталога, узнаёт запись.
      title: MCP_TITLE_EN,
      descriptionEn: MCP_DESCRIPTION_EN,
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
