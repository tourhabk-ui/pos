/**
 * GET /.well-known/mcp-registry-auth — доказательство владения именем в
 * официальном реестре MCP. Смысл, формат и три исхода — lib/mcp/registry-auth.ts;
 * здесь только перевод исхода в HTTP.
 */

import { NextResponse } from 'next/server';
import { registryAuthState } from '@/lib/mcp/registry-auth';

export const dynamic = 'force-dynamic';

const TEXT = { 'Content-Type': 'text/plain; charset=utf-8' };

export async function GET() {
  const auth = registryAuthState();
  if (auth.state === 'not_configured') {
    return new NextResponse('Not configured', { status: 404, headers: TEXT });
  }
  if (auth.state === 'malformed') {
    return new NextResponse(auth.reason, { status: 500, headers: TEXT });
  }
  return new NextResponse(auth.line, {
    headers: {
      ...TEXT,
      // Реестр читает файл в момент логина; кэш короткий, чтобы смена ключа
      // не ждала сутки.
      'Cache-Control': 'public, max-age=300',
    },
  });
}
