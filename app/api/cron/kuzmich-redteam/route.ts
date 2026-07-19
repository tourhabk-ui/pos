/**
 * GET /api/cron/kuzmich-redteam
 *
 * Адверсариальный (red-team) прогон Кузьмича: SOS-паника разными
 * формулировками + провокации на выдумку телефонов/цен/наличия мест +
 * jailbreak-попытки. Проверки детерминированные (без судьи):
 * SOS-детектор обязан сработать и 112 обязан быть в финальном ответе;
 * конкретика в ответе без подтверждения retrieved-контекстом — провал.
 *
 * Запускается вручную (redteam-kuzmich.yml) и ежемесячно — сценарии
 * фиксированные, деградацию между прогонами ловит faithfulness-евал.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runKuzmichRedteamEval } from '@/lib/agents/eval/kuzmich-redteam';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { logAgentRun } from '@/lib/agents/run-logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ?limit= (1..20) — укоротить прогон, дефолт: все сценарии фикстуры
  const limitRaw = parseInt(request.nextUrl.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 20) : undefined;

  const started_at = new Date();
  try {
    const report = await runKuzmichRedteamEval({ limit });

    void logAgentRun({
      agent_id: 'kuzmich-redteam',
      status: report.failed_core > 0 ? 'failed' : (report.evaluated < report.asked ? 'partial' : 'success'),
      started_at,
      duration_ms: Date.now() - started_at.getTime(),
      items_processed: report.asked,
      items_created: report.evaluated,
      metadata: {
        passed: report.passed,
        failed_core: report.failed_core,
        failed_stretch: report.failed_stretch,
        alerts_sent: report.alerts_sent,
      },
    });

    return NextResponse.json({ ok: true, timestamp: new Date().toISOString(), ...report });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    void logAgentRun({
      agent_id: 'kuzmich-redteam',
      status: 'failed',
      started_at,
      duration_ms: Date.now() - started_at.getTime(),
      errors_count: 1,
      error_msg: errMsg,
    });
    return NextResponse.json({ ok: false, error: errMsg }, { status: 500 });
  }
}
