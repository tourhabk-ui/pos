/**
 * GET /.well-known/agent.json — визитка A2A для клиентов версии 0.3 (старый
 * well-known путь, до 1.0). Перепись APIs.io (07.2026): 15 из 65 карточек
 * лежат только здесь, и клиенты 1.0 их не видят; у нас наоборот быть не
 * должно — обе версии по обоим адресам. Содержимое — lib/a2a/agent-card.
 */

import { NextResponse } from 'next/server';
import { buildLegacyAgentCard } from '@/lib/a2a/agent-card';
import { getPublicBaseUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  const base = getPublicBaseUrl().replace(/\/$/, '');
  return NextResponse.json(buildLegacyAgentCard(base), {
    headers: {
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
