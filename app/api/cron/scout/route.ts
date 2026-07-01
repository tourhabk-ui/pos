/**
 * POST /api/cron/scout
 * GET  /api/cron/scout  (backward compat, no git context)
 *
 * Scout-Innovator — ежедневный синтез разведданных → конкретные предложения.
 * Запускается через cron-scout.yml в 08:00 UTC (после Scout Digest в 07:00).
 * Требует env var GITHUB_ISSUES_TOKEN для создания GitHub Issues.
 *
 * POST body: { git_log?: string; changed_files?: string }
 * URL: https://vedarai.ru/api/cron/scout
 */

import { NextRequest, NextResponse } from 'next/server';
import { runScoutInnovator } from '@/lib/agents/scout-innovator';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { logAgentRun } from '@/lib/agents/run-logger';
import { getCronSecret } from '@/lib/auth/cron';
import { runWithUsageTracking } from '@/lib/ai/usage-context';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

async function runWithContext(
  gitContext: { git_log?: string; changed_files?: string },
  started_at: Date,
) {
  try {
    const { result, usage } = await runWithUsageTracking('scout', () => runScoutInnovator(gitContext));
    void logAgentRun({
      agent_id: 'scout',
      status: result.proposals_count > 0 ? 'success' : 'partial',
      started_at,
      duration_ms: result.duration_ms,
      items_processed: result.intel_entries,
      items_created: result.proposals_count + result.issues_created.length,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      llm_calls: usage.llm_calls,
      estimated_cost_usd: usage.estimated_cost_usd,
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

function checkAuth(request: NextRequest): NextResponse | null {
  const secret = getCronSecret(request);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function POST(request: NextRequest) {
  const authError = checkAuth(request);
  if (authError) return authError;

  const started_at = new Date();

  let gitContext: { git_log?: string; changed_files?: string } = {};
  try {
    const body: unknown = await request.json();
    if (body && typeof body === 'object') {
      const b = body as Record<string, unknown>;
      if (typeof b.git_log === 'string') gitContext.git_log = b.git_log;
      if (typeof b.changed_files === 'string') gitContext.changed_files = b.changed_files;
    }
  } catch {
    // body optional — proceed with empty context
  }

  return runWithContext(gitContext, started_at);
}

export async function GET(request: NextRequest) {
  const authError = checkAuth(request);
  if (authError) return authError;

  return runWithContext({}, new Date());
}
