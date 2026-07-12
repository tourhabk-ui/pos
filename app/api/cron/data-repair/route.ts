/**
 * GET /api/cron/data-repair?secret=<CRON_SECRET>[&apply=1]
 *
 * Ремонт географических данных по итогам инвентаризации: фейковые
 * координаты-заглушки, дубли мест, привязка треков всех источников,
 * нормализация source_name, места-статьи. Без apply=1 — dry-run
 * (диагностика, ни одного UPDATE). Дергается workflow'ом data-repair.yml.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { runDataRepair } from '@/lib/services/data-repair';
import { logAgentRun } from '@/lib/agents/run-logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const apply = request.nextUrl.searchParams.get('apply') === '1';
  const startedAt = new Date();
  try {
    const result = await runDataRepair(!apply);

    void logAgentRun({
      agent_id: 'data-repair',
      status: result.errors === 0 ? 'success' : 'partial',
      started_at: startedAt,
      duration_ms: result.duration_ms,
      metadata: result as unknown as Record<string, unknown>,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    void logAgentRun({
      agent_id: 'data-repair',
      status: 'failed',
      started_at: startedAt,
      duration_ms: Date.now() - startedAt.getTime(),
      errors_count: 1,
      error_msg: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Ошибка ремонта данных' },
      { status: 500 },
    );
  }
}
