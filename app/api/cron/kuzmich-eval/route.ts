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
import { sampleLiveQuestions } from '@/lib/agents/eval/live-questions';
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

  // ?source=live — вместо фикстуры сэмплируются реальные вопросы туристов
  // из chat_sessions за 7 дней (PII маскируется). Модели различают тестовый
  // и живой контекст (J-Lens, июль 2026) — фикстурный прогон может быть
  // систематически оптимистичнее реального трафика. ?limit= (1..15, дефолт 10)
  // держит длительность в бюджете maxDuration.
  const source = request.nextUrl.searchParams.get('source') === 'live' ? 'live' : 'fixture';
  const limitRaw = parseInt(request.nextUrl.searchParams.get('limit') ?? '10', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 15) : 10;

  const started_at = new Date();
  try {
    let liveCount = 0;
    let report;
    if (source === 'live') {
      const questions = await sampleLiveQuestions(limit);
      liveCount = questions.length;
      if (questions.length === 0) {
        return NextResponse.json({
          ok: true,
          timestamp: new Date().toISOString(),
          source,
          note: 'За 7 дней нет подходящих живых вопросов — прогон пропущен.',
          asked: 0,
        });
      }
      report = await runKuzmichFaithfulnessEval({ questions });
    } else {
      report = await runKuzmichFaithfulnessEval();
    }

    void logAgentRun({
      agent_id: source === 'live' ? 'kuzmich-eval-live' : 'kuzmich-eval',
      status: report.judge_unavailable_ratio > 0.3
        ? 'partial'
        : (report.pass_rate >= 0.8 ? 'success' : 'failed'),
      started_at,
      duration_ms: Date.now() - started_at.getTime(),
      items_processed: report.asked,
      items_created: report.judged,
      metadata: { pass_rate: report.pass_rate, wilson_low: report.wilson_low, alerts_sent: report.alerts_sent, source, live_sampled: liveCount },
    });

    return NextResponse.json({ ok: true, timestamp: new Date().toISOString(), source, ...report });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    void logAgentRun({
      agent_id: source === 'live' ? 'kuzmich-eval-live' : 'kuzmich-eval',
      status: 'failed',
      started_at,
      duration_ms: Date.now() - started_at.getTime(),
      errors_count: 1,
      error_msg: errMsg,
    });
    return NextResponse.json({ ok: false, error: errMsg }, { status: 500 });
  }
}
