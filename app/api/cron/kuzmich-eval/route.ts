/**
 * GET /api/cron/kuzmich-eval
 *
 * Faithfulness-регрессия живых ответов Кузьмича (Roitman §16.8.3): прогоняет
 * фиксированный набор из 20 вопросов через реальный retrieval + агент-цикл
 * Кузьмича, судья оценивает faithfulness ответа относительно приложенного
 * контекста. Порог тревоги — pass_rate < 0.8 или >30% ответов без вердикта
 * судьи (тогда "судья недоступен", а не ложное "всё хорошо").
 *
 * Еженедельно (cron-kuzmich-eval.yml) — Кузьмич отвечает туристам постоянно,
 * реже чем Editor (раз в сутки) достаточно для отслеживания деградации.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runKuzmichFaithfulnessEval } from '@/lib/agents/eval/kuzmich-faithfulness';
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

  const started_at = new Date();
  try {
    const report = await runKuzmichFaithfulnessEval();

    void logAgentRun({
      agent_id: 'kuzmich-eval',
      status: report.judge_unavailable_ratio > 0.3
        ? 'partial'
        : (report.pass_rate >= 0.8 ? 'success' : 'failed'),
      started_at,
      duration_ms: Date.now() - started_at.getTime(),
      items_processed: report.asked,
      items_created: report.judged,
      metadata: { pass_rate: report.pass_rate, wilson_low: report.wilson_low, alerts_sent: report.alerts_sent },
    });

    return NextResponse.json({ ok: true, timestamp: new Date().toISOString(), ...report });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    void logAgentRun({
      agent_id: 'kuzmich-eval',
      status: 'failed',
      started_at,
      duration_ms: Date.now() - started_at.getTime(),
      errors_count: 1,
      error_msg: errMsg,
    });
    return NextResponse.json({ ok: false, error: errMsg }, { status: 500 });
  }
}
