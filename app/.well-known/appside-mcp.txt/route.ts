/**
 * GET /.well-known/appside-mcp.txt — подтверждение владения vedarai.ru для
 * Appside MCP Directory (#3423). Одна строка, text/plain, без авторизации
 * и редиректов. Значение и объяснение — lib/mcp/catalogs.ts.
 */
import { NextResponse } from 'next/server';
import { APPSIDE_MCP_VERIFICATION } from '@/lib/mcp/catalogs';

export async function GET() {
  return new NextResponse(APPSIDE_MCP_VERIFICATION, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
