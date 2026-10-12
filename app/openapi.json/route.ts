/**
 * GET /openapi.json — описание OpenAPI 3.1 для агентов без MCP и A2A-клиентов
 * (GPT Actions, Copilot Studio, OpenAPI-наборы фреймворков). Содержимое —
 * lib/api/openapi.ts, из реестра инструментов и server.json.
 *
 * Лежит вне /api намеренно: Edge пускает анонима только к перечисленным
 * префиксам, а robots закрывает /api/ целиком — спецификацию, которую
 * агент не может прочитать, описывать бессмысленно (прежний /api/docs отвечал
 * анониму 401 и держал пустой список путей под прежним именем платформы).
 *
 * Медиатип: application/json по умолчанию — его читают все импортёры;
 * зарегистрированный application/vnd.oai.openapi+json — если клиент просит
 * его в Accept. ETag и 304, CORS на чтение — как у карточки сервера.
 */

import { NextResponse } from 'next/server';
import { getPublicBaseUrl } from '@/lib/config';
import { buildOpenApiDocument, OPENAPI_MEDIA_TYPE, OPENAPI_PATH } from '@/lib/api/openapi';
import { weakEtag } from '@/lib/mcp/server-card';
import { recordAgentEntryHit } from '@/lib/analytics/agent-entry-hits';

export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
} as const;

export async function GET(request?: Request) {
  recordAgentEntryHit(OPENAPI_PATH, request?.headers.get('user-agent') ?? null);
  const body = JSON.stringify(buildOpenApiDocument(getPublicBaseUrl()), null, 2);
  const etag = weakEtag(body);
  const wantsOas = (request?.headers.get('accept') ?? '').includes(OPENAPI_MEDIA_TYPE);
  const headers = {
    ...CORS,
    'Content-Type': `${wantsOas ? OPENAPI_MEDIA_TYPE : 'application/json'}; charset=utf-8`,
    'Cache-Control': 'public, max-age=3600',
    ETag: etag,
  };
  if (request?.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers });
  }
  return new NextResponse(body, { status: 200, headers });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
