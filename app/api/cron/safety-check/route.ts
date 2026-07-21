/**
 * Cron: синтетическая проверка safety-флоу на живой системе.
 *
 * Прогоняет инварианты безопасности (SOS-детектор, экстренные номера, телефон
 * МЧС на маршрутах, покупаемый тур, профили безопасности) на боевых данных и
 * возвращает отчёт. criticalFail = сломано ядро обещания (турист в ЧП не
 * получит 112) — воркфлоу краснит ран.
 *
 * Read-only: лидов/броней не создаёт. Первый прогон — правкой
 * .github/triggers/safety-check.json в main.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runSafetySelfCheck } from '@/lib/safety/safety-selfcheck';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { logAgentRun } from '@/lib/agents/run-logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const started_at = new Date();
  const report = await runSafetySelfCheck();

  const failedWarn = report.checks.filter((c) => c.level === 'warn' && !c.pass).length;
  void logAgentRun({
    agent_id: 'safety-check',
    status: report.criticalFail ? 'failed' : failedWarn > 0 ? 'partial' : 'success',
    started_at,
    duration_ms: Date.now() - started_at.getTime(),
    items_processed: report.checks.length,
    errors_count: report.checks.filter((c) => !c.pass).length,
    error_msg: report.criticalFail
      ? report.checks.filter((c) => c.level === 'critical' && !c.pass).map((c) => `${c.id}: ${c.detail}`).join('; ')
      : undefined,
  });

  // Всегда HTTP 200, чтобы проба могла прочитать тело; сигнал — в полях
  // ok/criticalFail. Воткфлоу краснит по criticalFail.
  return NextResponse.json(report);
}
