import { runCheckinMonitor } from '@/lib/agents/checkin-monitor';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { logAgentRun } from '@/lib/agents/run-logger';

/**
 * GET /api/cron/checkin-monitor
 * Проверяет туристические чекины с просроченным дедлайном.
 * Запускать каждые 30 минут.
 */
export async function GET(req: Request) {
  const authHeader = req instanceof Request ? req.headers.get('authorization') : null;
  const secret = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const started_at = new Date();
  try {
    const result = await runCheckinMonitor();
    void logAgentRun({
      agent_id: 'checkin-monitor',
      status: 'success',
      started_at,
      duration_ms: Date.now() - started_at.getTime(),
      metadata: result as unknown as Record<string, unknown>,
    });
    return Response.json({ success: true, ...result });
  } catch (err) {
    void logAgentRun({
      agent_id: 'checkin-monitor',
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
