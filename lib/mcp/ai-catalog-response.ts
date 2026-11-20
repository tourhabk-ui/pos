/**
 * Ответ каталога домена — один на оба пути: /.well-known/ard.json (ARD,
 * преемник) и /.well-known/ai-catalog.json (прежнее имя, его читают уже
 * подключённые агенты). Тело одно — buildAiCatalog; различается только
 * медиатип. Час кэша, ETag с 304, CORS только на чтение.
 */

import { NextResponse } from 'next/server';
import { getPublicBaseUrl } from '@/lib/config';
import { buildAiCatalog, weakEtag } from '@/lib/mcp/server-card';

export const CATALOG_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
} as const;

export function catalogResponse(request: Request | undefined, mediaType: string): NextResponse {
  const body = JSON.stringify(buildAiCatalog(getPublicBaseUrl()), null, 2);
  const etag = weakEtag(body);
  const headers = {
    ...CATALOG_CORS,
    'Content-Type': `${mediaType}; charset=utf-8`,
    'Cache-Control': 'public, max-age=3600',
    ETag: etag,
  };
  if (request?.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers });
  }
  return new NextResponse(body, { status: 200, headers });
}

export function catalogOptions(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CATALOG_CORS });
}
