import { runScoutDigest } from '@/lib/agents/scout-digest';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { logAgentRun } from '@/lib/agents/run-logger';
import { getCronSecret } from '@/lib/auth/cron';
import { runWithUsageTracking } from '@/lib/ai/usage-context';

/**
 * GET /api/cron/scout-digest
 * Ежедневный разведывательный дайджест: RSS → AI-синтез → Telegram.
 * Запускать раз в сутки (утром, ~07:00 UTC).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = getCronSecret(req);

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const started_at = new Date();
  try {
    const { result, usage } = await runWithUsageTracking('scout-digest', () => runScoutDigest());
    void logAgentRun({
      agent_id: 'scout-digest',
      status: result.digest_sent ? 'success' : 'partial',
      started_at,
      duration_ms: result.duration_ms,
      items_processed: result.signals_found,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      llm_calls: usage.llm_calls,
      estimated_cost_usd: usage.estimated_cost_usd,
    });
    return Response.json({ success: true, ...result });
  } catch (err) {
    void logAgentRun({
      agent_id: 'scout-digest',
      status: 'failed',
      started_at,
      duration_ms: Date.now() - started_at.getTime(),
      errors_count: 1,
      error_msg: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
