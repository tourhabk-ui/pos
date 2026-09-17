/**
 * GET /.well-known/mcp-registry-auth — доказательство владения именем
 * `ru.vedarai/mcp` в официальном реестре MCP. Ключ и объяснение —
 * lib/mcp/registry-auth.ts; здесь только отдача строки.
 */

import { NextResponse } from 'next/server';
import { registryAuthLine } from '@/lib/mcp/registry-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  return new NextResponse(registryAuthLine(), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // Реестр читает файл в момент логина; кэш короткий, чтобы ротация
      // ключа не ждала сутки.
      'Cache-Control': 'public, max-age=300',
    },
  });
}
