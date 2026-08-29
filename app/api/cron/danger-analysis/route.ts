import { runDangerAnalysis } from '@/lib/agents/agencies/danger-analyst-agency';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { claimCronWindow, shouldRun, leaseSkipBody } from '@/lib/agents/cron-lease';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';

/**
 * GET /api/cron/danger-analysis
 * Запускает AI-анализ опасностей по всем зонам Камчатки
 * Сохраняет в danger_assessments
 * Запускать каждые 30 минут (после safety-ingest)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = getCronSecret(req);

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return Response.json({ error: 'Unauthorized', ...diagnoseCronAuth(req) }, { status: 401 });
  }

  const lease = await claimCronWindow('danger-analysis', 30, 'external');
  if (!shouldRun(lease)) return Response.json(leaseSkipBody('danger-analysis', 30));

  const startedAt = Date.now();

  try {
    const result = await runDangerAnalysis();

    recordCronRun('danger-analysis', startedAt, 'success', { items: result.assessments.length });
    return Response.json({
      success: true,
      duration_ms: Date.now() - startedAt,
      zones_analyzed: result.assessments.length,
      high_risk_zones: result.high_risk_zones,
      total_tourists_at_risk: result.total_tourists_at_risk,
      stand_down_zones: result.stand_down_zones,
      assessments: result.assessments.map(a => ({
        zone: a.zone,
        risk_score: a.risk_score,
        risk_level: a.risk_level,
        recommended_action: a.recommended_action,
        tourists_at_risk: a.tourists_at_risk,
      })),
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  } catch (error) {
    recordCronRun('danger-analysis', startedAt, 'failed', { error: (error as Error).message });
    return Response.json(
      { success: false, error: (error as Error).message, duration_ms: Date.now() - startedAt },
      { status: 500 }
    );
  }
}
