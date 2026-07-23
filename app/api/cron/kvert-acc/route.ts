/**
 * GET /api/cron/kvert-acc — периодический синк авиационных цветовых кодов (ACC)
 * вулканов из KVERT VONA в volcano_status (migration 728).
 *
 * Запускается GitHub Actions по расписанию (cron-kvert-acc.yml) с Bearer CRON_SECRET.
 * Сетевая выборка KVERT идёт с этого прод-сервера (российский IP Timeweb) —
 * поэтому KVERT доступен (не-РФ адресам он отдаёт 403).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { syncKvertAcc } from '@/lib/agents/kvert-sync';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();

  try {
    const result = await syncKvertAcc();
    recordCronRun('kvert-acc', startedAt, 'success');
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка синка KVERT';
    recordCronRun('kvert-acc', startedAt, 'failed', { error: message });
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
