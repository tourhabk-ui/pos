/**
 * GET /api/mcp/server-card — карточка MCP-сервера (экспериментальное
 * расширение MCP, SEP-2127). Документ, который агент читает ДО рукопожатия:
 * имя, версия, описание, адрес Streamable HTTP и поддерживаемые версии
 * протокола. Инструментов здесь нет по спецификации — клиент сверяет карточку
 * с живым сервером и верит серверу, не карточке.
 *
 * Адрес — суффикс к Streamable HTTP URL (`<url>/server-card`), не под
 * /.well-known: там место доменного AI Catalog, который на эту карточку
 * ссылается. Медиатип, ETag с 304, час кэша и CORS только на чтение — по
 * docs/discovery.md расширения. Содержимое — lib/mcp/server-card из того же
 * server.json, что в реестре MCP и Smithery.
 */

import { NextResponse } from 'next/server';
import { getPublicBaseUrl } from '@/lib/config';
import { buildServerCard, weakEtag, SERVER_CARD_MEDIA_TYPE, SERVER_CARD_PATH } from '@/lib/mcp/server-card';
import { recordAgentEntryHit } from '@/lib/analytics/agent-entry-hits';

export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
} as const;

export async function GET(request?: Request) {
  // Перепись краулеров по семействам: кто читает карточку.
  recordAgentEntryHit(SERVER_CARD_PATH, request?.headers.get('user-agent') ?? null);
  const body = JSON.stringify(buildServerCard(getPublicBaseUrl()), null, 2);
  const etag = weakEtag(body);
  const headers = {
    ...CORS,
    'Content-Type': `${SERVER_CARD_MEDIA_TYPE}; charset=utf-8`,
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
