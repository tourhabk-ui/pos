/**
 * GET /.well-known/ai-catalog.json — AI Catalog домена (Linux Foundation,
 * Agent-Card/ai-catalog): один список всего, что у нас есть для агентов —
 * карточка MCP-сервера и визитки A2A обеих версий, каждая со своим медиатипом
 * и адресом. Агент, нашедший домен, читает этот файл и дальше идёт по ссылкам;
 * сами артефакты здесь не пересказываются (название и описание — в них).
 *
 * Содержимое — lib/mcp/server-card (из server.json и констант A2A), чтобы
 * имена и версии не расходились с реестром и визитками. Медиатип
 * application/ai-catalog+json, час кэша, ETag с 304, CORS на чтение.
 */

import { NextResponse } from 'next/server';
import { getPublicBaseUrl } from '@/lib/config';
import { buildAiCatalog, weakEtag, AI_CATALOG_MEDIA_TYPE, AI_CATALOG_PATH } from '@/lib/mcp/server-card';
import { recordAgentEntryHit } from '@/lib/analytics/agent-entry-hits';

export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
} as const;

export async function GET(request?: Request) {
  // Перепись краулеров по семействам: кто читает каталог домена.
  recordAgentEntryHit(AI_CATALOG_PATH, request?.headers.get('user-agent') ?? null);
  const body = JSON.stringify(buildAiCatalog(getPublicBaseUrl()), null, 2);
  const etag = weakEtag(body);
  const headers = {
    ...CORS,
    'Content-Type': `${AI_CATALOG_MEDIA_TYPE}; charset=utf-8`,
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
