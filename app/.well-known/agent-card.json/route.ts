/**
 * GET /.well-known/agent-card.json — визитка A2A-агента (спецификация 1.0,
 * раздел 14.3: well-known суффикс `agent-card.json`).
 *
 * Сервер A2A (/api/a2a) без визитки по общему адресу агент найти не может —
 * та же мысль, что у /.well-known/mcp.json. Содержимое собирает
 * lib/a2a/agent-card из того же реестра инструментов, что MCP-сервер:
 * обещать навык, которого нет в сервере, карточка не может.
 */

import { NextResponse } from 'next/server';
import { buildAgentCard } from '@/lib/a2a/agent-card';
import { getPublicBaseUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  const base = getPublicBaseUrl().replace(/\/$/, '');
  return NextResponse.json(buildAgentCard(base), {
    headers: {
      // Визитку читают краулеры и чужие раннеры: кэшировать, но не навсегда —
      // навыки меняются вместе с реестром инструментов.
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
