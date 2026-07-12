/**
 * GET /api/cron/osm-traces?secret=<CRON_SECRET>
 *
 * OSM Traces Scout: ежесуточный сбор публичных GPS-записей туристов
 * с openstreetmap.org/traces по Камчатке. Треки пишутся скрытыми
 * (is_visible=false) на ревью владельцу, дайджест уходит в Telegram.
 * Дергается workflow'ом cron-osm-traces.yml.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { scoutOsmTraces } from '@/lib/services/osm-traces-scout';
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
    const result = await scoutOsmTraces();

    void logAgentRun({
      agent_id: 'osm-traces-scout',
      status: result.errors === 0 ? 'success' : 'partial',
      started_at: startedAt,
      duration_ms: result.duration_ms,
      metadata: result as unknown as Record<string, unknown>,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    void logAgentRun({
      agent_id: 'osm-traces-scout',
      status: 'failed',
      started_at: startedAt,
      duration_ms: Date.now() - startedAt.getTime(),
      errors_count: 1,
      error_msg: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Ошибка OSM Traces Scout' },
      { status: 500 },
    );
  }
}
