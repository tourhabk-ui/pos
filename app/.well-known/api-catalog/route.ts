/**
 * GET /.well-known/api-catalog — каталог API по RFC 9727: linkset (RFC 9264)
 * с контекстами «публичный API», «MCP» и «A2A» и ссылками service-desc
 * (описания: OpenAPI, карточка сервера, визитки), service-doc (страница /mcp,
 * llms.txt) и service-meta (условия). Это стандартный способ найти описание
 * API по домену; на него же указывает заголовок Link rel="api-catalog" у
 * главной страницы (next.config.js).
 *
 * Содержимое — lib/api/openapi.ts (buildApiCatalog). Медиатип
 * application/linkset+json, ETag и 304, CORS на чтение.
 */

import { NextResponse } from 'next/server';
import { getPublicBaseUrl } from '@/lib/config';
import { buildApiCatalog, LINKSET_MEDIA_TYPE, API_CATALOG_PATH } from '@/lib/api/openapi';
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
  recordAgentEntryHit(API_CATALOG_PATH, request?.headers.get('user-agent') ?? null);
  const body = JSON.stringify(buildApiCatalog(getPublicBaseUrl()), null, 2);
  const etag = weakEtag(body);
  const headers = {
    ...CORS,
    'Content-Type': `${LINKSET_MEDIA_TYPE}; charset=utf-8`,
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
