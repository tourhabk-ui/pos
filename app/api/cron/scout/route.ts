/**
 * GET /api/cron/scout
 *
 * Scout-Innovator — ежедневный синтез разведданных → конкретные предложения.
 * Запускается через cron-scout.yml в 08:00 UTC (после Scout Digest в 07:00).
 * Требует env var GITHUB_ISSUES_TOKEN для создания GitHub Issues.
 *
 * URL: https://vedarai.ru/api/cron/scout?secret=<CRON_SECRET>
 */

import { NextRequest, NextResponse } from 'next/server';
import { runScoutInnovator } from '@/lib/agents/scout-innovator';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { logAgentRun } from '@/lib/agents/run-logger';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const started_at = new Date();
  try {
    const result = await runScoutInnovator();
    void logAgentRun({
      agent_id: 'scout',
      status: result.proposals_count > 0 ? 'success' : 'partial',
      started_at,
      duration_ms: result.duration_ms,
      items_processed: result.intel_entries,
      items_created: result.proposals_count + result.issues_created.length,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[cron/scout] Unhandled error:', errMsg);
    void logAgentRun({
      agent_id: 'scout',
      status: 'failed',
      started_at,
      duration_ms: Date.now() - started_at.getTime(),
      errors_count: 1,
      error_msg: errMsg,
    });
    return NextResponse.json({ ok: false, error: errMsg }, { status: 500 });
  }
}
