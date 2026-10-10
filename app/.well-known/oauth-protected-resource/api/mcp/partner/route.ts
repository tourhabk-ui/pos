/**
 * GET /.well-known/oauth-protected-resource/api/mcp/partner — метаданные
 * ресурса (RFC 9728) MCP партнёра.
 *
 * На этот адрес указывает 401 роута /api/mcp/partner. По нему приложение
 * Claude узнаёт, у кого просить токен; без документа кнопка «Подключить»
 * заканчивается словами «Couldn't reach the MCP server». Документ один —
 * lib/crm/partner-oauth-metadata.ts; сторож partner-mcp-oauth держит
 * `resource` равным адресу, который партнёр вводит в Claude.
 */
import { NextResponse } from 'next/server';
import { protectedResourceMetadata } from '@/lib/crm/partner-oauth-metadata';

export function GET() {
  return NextResponse.json(protectedResourceMetadata(), {
    headers: { 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' },
  });
}
