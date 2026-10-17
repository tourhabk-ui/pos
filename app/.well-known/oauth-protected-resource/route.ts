/**
 * GET /.well-known/oauth-protected-resource — корневые метаданные ресурса
 * (RFC 9728) для самого хоста.
 *
 * Раньше здесь был только вложенный документ партнёра
 * (./api/mcp/partner), а корень отдавал 404 — каталоги и проверки
 * (ChatGPT Apps, Claude) спрашивают именно корень.
 *
 * Публичный MCP /api/mcp работает БЕЗ авторизации, поэтому корень намеренно
 * не объявляет authorization_servers: иначе клиент решил бы, что для
 * /api/mcp нужен OAuth. OAuth есть только у MCP партнёра, его документ —
 * /.well-known/oauth-protected-resource/api/mcp/partner (не трогаем).
 */
import { NextResponse } from 'next/server';
import { OAUTH_ISSUER } from '@/lib/crm/partner-oauth-public';

export function GET() {
  return NextResponse.json(
    {
      resource: OAUTH_ISSUER,
      resource_name: 'Ведар — Камчатка (публичный MCP без авторизации)',
      resource_documentation: `${OAUTH_ISSUER}/mcp`,
    },
    { headers: { 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' } },
  );
}
