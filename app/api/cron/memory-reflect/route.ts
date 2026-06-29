/**
 * GET /api/cron/memory-reflect?secret=<CRON_SECRET>
 *
 * Рефлектор памяти (Roitman §17.4.4): синтезирует эпизодические разведсигналы
 * из agent_memory (TTL 3-7 дней) в durable-инсайты в agent_knowledge,
 * пока эпизоды не истекли. Анти-галлюцинация: только из переданных сигналов.
 *
 * Рекомендуемый интервал: раз в сутки (после прогона мониторинга каналов).
 */

import { NextRequest, NextResponse } from 'next/server';
import { runMemoryReflector } from '@/lib/agents/memory-reflector';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runMemoryReflector();
    return NextResponse.json({ ok: true, timestamp: new Date().toISOString(), ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
