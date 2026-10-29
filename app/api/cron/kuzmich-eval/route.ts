/**
 * GET /api/cron/kuzmich-eval
 *
 * Faithfulness-регрессия живых ответов Кузьмича (Roitman §16.8.3): прогоняет
 * фиксированный набор из 20 вопросов (`?set=commercial` — вопросы о турах,
 * судятся ещё и критериями, lib/agents/eval/commercial-checks.ts) через
 * реальный retrieval + агент-цикл
 * Кузьмича, судья оценивает faithfulness ответа относительно приложенного
 * контекста. Порог тревоги — pass_rate < 0.8 или >30% ответов без вердикта
 * судьи (тогда "судья недоступен", а не ложное "всё хорошо").
 *
 * Еженедельно (cron-kuzmich-eval.yml) — Кузьмич отвечает туристам постоянно,
 * реже чем Editor (раз в сутки) достаточно для отслеживания деградации.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runKuzmichFaithfulnessEval, failedCases } from '@/lib/agents/eval/kuzmich-faithfulness';
import { fixtureQuestions, commercialFailures } from '@/lib/agents/eval/kuzmich-faithfulness';
import { commercialRunStatus } from '@/lib/agents/eval/commercial-checks';
import { sampleLiveQuestions } from '@/lib/agents/eval/live-questions';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { logAgentRun } from '@/lib/agents/run-logger';
import { runWithUsageTracking } from '@/lib/ai/usage-context';

export const dynamic = 'force-dynamic';
// Потолок поднят вместе с потолком curl в workflow (замер 11.09): двадцать
// вопросов фикстуры идут пачками по EVAL_CONCURRENCY, но худший случай должен
// помещаться с запасом, а не вровень. На Timeweb это самодокументация —
// значение соблюдает платформа Vercel, у нас поток режет только curl.
export const maxDuration = 600;

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
  // ?set=commercial — вопросы о турах (шаг 1 разбора «мозг Кузьмича», 29.10):
  // отдельный прогон, чтобы pass_rate базовых двадцати остался сравним со
  // своей историей. Судятся критериями против эталона в момент прогона.
  const commercialSet = source === 'fixture' && request.nextUrl.searchParams.get('set') === 'commercial';
  const limitRaw = parseInt(request.nextUrl.searchParams.get('limit') ?? '10', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 15) : 10;

  const started_at = new Date();
  // Имя прогона — и в журнале, и в книгах расхода. Без учёта агента ноги
  // цикла пишут ход эвала как живого Кузьмича ('kuzmich'), и сотня вопросов
  // эвала легла бы в замер «до» по поверхностям и провайдерам (ревью 29.10).
  const agentId = source === 'live' ? 'kuzmich-eval-live' : (commercialSet ? 'kuzmich-eval-commercial' : 'kuzmich-eval');
  try {
    let liveCount = 0;
    let report;
    if (source === 'live') {
      const questions = await sampleLiveQuestions(limit);
      liveCount = questions.length;
      if (questions.length === 0) {
        // Пропуск ПИШЕТСЯ в журнал, а не только возвращается вызывающему.
        // Прежде этот выход не оставлял следа вовсе: прогон уходил в тишину, и
        // ни liveness Watchdog'а, ни разбор «почему eval молчит» не отличали
        // «крон не запускался» от «крон отработал и ему нечего было спрашивать».
        // Ответ живёт до конца HTTP-запроса, журнал — дольше (§4.0).
        void logAgentRun({
          agent_id: agentId,
          status: 'partial',
          started_at,
          duration_ms: Date.now() - started_at.getTime(),
          items_processed: 0,
          items_created: 0,
          metadata: { skip_reason: 'no_live_questions', source, live_sampled: 0 },
        });
        return NextResponse.json({
          ok: true,
          timestamp: new Date().toISOString(),
          source,
          note: 'За 7 дней нет подходящих живых вопросов — прогон пропущен.',
          skip_reason: 'no_live_questions',
          asked: 0,
        });
      }
      report = (await runWithUsageTracking(agentId, () => runKuzmichFaithfulnessEval({ questions }))).result;
    } else {
      const questions = fixtureQuestions(commercialSet ? 'commercial' : 'base');
      report = (await runWithUsageTracking(agentId, () => runKuzmichFaithfulnessEval({ questions }))).result;
    }

    // Исход прогона и ПРИЧИНА, по которой он не «success», считаются вместе:
    // иначе они расходятся. Watchdog читает общий ключ `skip_reason` у любого
    // крона (lib/agents/cron-fruitless), и без него тревога о девяти прогонах
    // подряд без результата заканчивалась словами «причина пропуска не
    // записана» — то есть звала разбираться, не сказав куда.
    //
    // Три исхода, не два (§4.0): судья не ответил — это «не смог проверить», и
    // валить его в одну кучу с «проверили, плохо» нельзя. Первый чинят у
    // провайдера, второй — в ответах Кузьмича.
    const judgeMostlySilent = report.judge_unavailable_ratio > 0.3;
    const status = judgeMostlySilent ? 'partial' : (report.pass_rate >= 0.8 ? 'success' : 'failed');
    const skip_reason = judgeMostlySilent
      ? 'judge_unavailable'
      : (report.pass_rate >= 0.8 ? null : 'pass_rate_below_threshold');
    // Коммерческий набор судится своими критериями: исход прогона — их, а
    // faithfulness судьи едет рядом в metadata.
    const outcome: ReturnType<typeof commercialRunStatus> = commercialSet
      ? commercialRunStatus(report.commercial)
      : { status, skip_reason };

    void logAgentRun({
      agent_id: agentId,
      status: outcome.status,
      started_at,
      duration_ms: Date.now() - started_at.getTime(),
      items_processed: report.asked,
      items_created: report.judged,
      metadata: {
        skip_reason: outcome.skip_reason,
        pass_rate: report.pass_rate,
        wilson_low: report.wilson_low,
        judge_unavailable_ratio: report.judge_unavailable_ratio,
        alerts_sent: report.alerts_sent,
        source,
        live_sampled: liveCount,
        // Что именно упало (#1883). Без этого следующий провал разбирается
        // археологией в логе Actions: тревога несёт только pass_rate, и
        // «75%» не говорит, какие вопросы и чем плохи. Вопросы живого
        // трафика чистятся redactPII — это сообщения туристов (§8).
        failed_cases: failedCases(report.cases),
        ...(report.commercial ? {
          commercial: report.commercial,
          commercial_failures: commercialFailures(report.cases),
        } : {}),
      },
    });

    return NextResponse.json({ ok: true, timestamp: new Date().toISOString(), source, set: commercialSet ? 'commercial' : 'base', ...report });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    void logAgentRun({
      agent_id: agentId,
      status: 'failed',
      started_at,
      duration_ms: Date.now() - started_at.getTime(),
      errors_count: 1,
      error_msg: errMsg,
      // Падение — тоже причина, и без кода оно попадало в тревогу как пропуск
      // «причина не записана». Текст ошибки лежит рядом в error_msg.
      metadata: { skip_reason: 'run_threw', source },
    });
    return NextResponse.json({ ok: false, error: errMsg }, { status: 500 });
  }
}
