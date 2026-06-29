/**
 * GET /api/cron/memory-contradiction?secret=<CRON_SECRET>
 *
 * Детектор противоречий в памяти (Roitman §17.4.1): периодически сканирует
 * разведсигналы + инсайты, флагует ПРЯМЫЕ несовместимые утверждения об одном
 * объекте в agent_knowledge (type='contradiction'); high-severity → алерт админу.
 *
 * Рекомендуемый интервал: раз в сутки (после рефлектора памяти).
 */

import { NextRequest, NextResponse } from 'next/server';
import { runContradictionScan } from '@/lib/agents/memory-contradiction';
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
    const result = await runContradictionScan();
    return NextResponse.json({ ok: true, timestamp: new Date().toISOString(), ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
