/**
 * GET /api/cron/data-inventory?secret=<CRON_SECRET>
 *
 * Инвентаризация географических данных (места/маршруты/треки): дубли,
 * имена-статьи, привязки, разбивка по источникам. READ-ONLY.
 * Дергается workflow'ом data-inventory.yml — тот печатает отчёт целиком.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { runDataInventory } from '@/lib/services/data-inventory';
import { logAgentRun } from '@/lib/agents/run-logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = new Date();
  try {
    const result = await runDataInventory();
    const errors = result.sections.filter(s => s.error).length;

    void logAgentRun({
      agent_id: 'data-inventory',
      status: errors === 0 ? 'success' : 'partial',
      started_at: startedAt,
      duration_ms: result.duration_ms,
      metadata: {
        sections: result.sections.map(s => ({ id: s.id, rows: s.rows.length, error: s.error })),
      },
    });

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    void logAgentRun({
      agent_id: 'data-inventory',
      status: 'failed',
      started_at: startedAt,
      duration_ms: Date.now() - startedAt.getTime(),
      errors_count: 1,
      error_msg: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Ошибка инвентаризации' },
      { status: 500 },
    );
  }
}
