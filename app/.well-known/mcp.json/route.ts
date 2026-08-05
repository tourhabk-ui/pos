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
import { getPublicBaseUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  const base = getPublicBaseUrl().replace(/\/$/, '');

  return NextResponse.json(
    {
      ...MCP_SERVER_INFO,
      // Streamable HTTP: один URL, JSON-RPC 2.0 поверх POST.
      transport: 'streamable-http',
      endpoint: `${base}/api/mcp`,
      documentation: `${base}/llms.txt`,
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
