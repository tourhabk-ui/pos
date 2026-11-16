/**
 * GET /.well-known/poppy.json — документ обнаружения Poppy 1.0 для личных
 * агентов (#3459). Содержимое и правила полей — lib/mcp/poppy.
 * JSON, час кэша, CORS на чтение — как у соседних документов для агентов.
 */
import { NextResponse } from 'next/server';
import { buildPoppyDocument, POPPY_PATH } from '@/lib/mcp/poppy';
import { recordAgentEntryHit } from '@/lib/analytics/agent-entry-hits';

export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept',
} as const;

export async function GET(request?: Request) {
  // Перепись краулеров по семействам: читают ли личные агенты.
  recordAgentEntryHit(POPPY_PATH, request?.headers.get('user-agent') ?? null);
  return NextResponse.json(buildPoppyDocument(), {
    status: 200,
    headers: { ...CORS, 'Cache-Control': 'public, max-age=3600' },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
