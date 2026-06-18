import { runEditor } from '@/lib/agents/editor';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { logAgentRun } from '@/lib/agents/run-logger';
import { getCronSecret } from '@/lib/auth/cron';
import { readAgentBriefing } from '@/lib/agents/warmup';
import { smokeTestEditorWrites } from '@/lib/agents/smoke-test';

/**
 * GET /api/cron/editor
 * AI-редактор описаний туров: находит туры с короткими описаниями,
 * переписывает через AI, сохраняет в route_description_cache.
 * Запускать раз в сутки (ночью, ~02:00 UTC).
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
    // Warm-up: read platform briefing + own run history before editing.
    // Provides context so the agent knows what was already processed.
    const briefing = await readAgentBriefing('editor');
    const result = await runEditor(briefing);

    // Smoke test: verify writes actually happened in DB (не доверяй result.improved)
    const smoke = await smokeTestEditorWrites(result.improved ?? 0, started_at);

    void logAgentRun({
      agent_id: 'editor',
      status: smoke.passed ? 'success' : 'failed',
      started_at,
      duration_ms: Date.now() - started_at.getTime(),
      items_processed: result.processed,
      items_created: result.improved,
      error_msg: smoke.passed ? undefined : smoke.message,
      metadata: { ...result as unknown as Record<string, unknown>, smoke } as Record<string, unknown>,
    });
    return Response.json({ success: true, smoke: smoke.passed ? 'ok' : 'FAIL', ...result });
  } catch (err) {
    void logAgentRun({
      agent_id: 'editor',
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
