import { runScoutDigest } from '@/lib/agents/scout-digest';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { logAgentRun } from '@/lib/agents/run-logger';
import { getCronSecret } from '@/lib/auth/cron';
import { runWithUsageTracking } from '@/lib/ai/usage-context';
import { pool } from '@/lib/db-pool';
import { countLeadingSkips, silenceIsCritical, MAX_SILENT_RUNS } from '@/lib/agents/scout-silence';

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
      // Причина пропуска ДОЛЖНА пережить запрос.
      //
      // runScoutDigest считает её в восьми точках выхода и отдаёт в HTTP-ответ
      // — а журнал её не брал. Ответ живёт до конца запроса; крон дёргает
      // GitHub Actions, ответ уходит в лог прогона и через сутки недостижим.
      // Поэтому монитор здоровья умел сказать только «разведчик молчит,
      // причина — digest_skip_reason в ответе cron/scout-digest», то есть
      // отправить человека дёрнуть крон руками. Тринадцать дней молчания —
      // тринадцать дней, когда причина существовала и была стёрта.
      //
      // `null` при отправленном выпуске — это «проверено, причины нет», а не
      // «не записали»: поле есть всегда.
      metadata: {
        digest_skip_reason: result.digest_skip_reason ?? null,
        // Улика переживает запрос вместе с причиной: без неё «ответила
        // прозой» остаётся догадкой, а догадка уже стоила трёх недель.
        digest_skip_detail: result.digest_skip_detail ?? null,
        // Выпуск ушёл, но без вычеркнутых пунктов (02.09): число и какие.
        claims_dropped: result.claims_dropped ?? null,
        claims_dropped_detail: result.claims_dropped_detail ?? null,
      },
    });
    /**
     * Молчание подряд — повод покраснеть, а не только предупредить.
     *
     * Один пропуск это осторожность агента: лучше не выпустить, чем выпустить
     * непроверенное. Три подряд означают, что ворота держат его
     * систематически. 1–8.08 неделя тишины прошла при зелёных прогонах, 18.08
     * то же повторилось на семнадцати днях: алерт в Telegram про молчание уже
     * был, но предупреждение читают среди других, а красный прогон в Actions
     * требует ответа.
     *
     * Журнал читается ДО учёта текущего прогона: свою строку он пишет фоново
     * и к моменту ответа может там ещё не появиться.
     */
    let silentRuns = 0;
    try {
      const hist = await pool.query<{ status: string }>(
        `SELECT status FROM agent_run_history
          WHERE agent_id = 'scout-digest'
          ORDER BY started_at DESC LIMIT 20`,
      );
      silentRuns = countLeadingSkips(hist.rows);
    } catch {
      // Журнал недоступен — не повод объявлять тишину: это неизвестность, а
      // не молчание. Прогон остаётся зелёным, здоровье скажет отдельно.
      silentRuns = 0;
    }
    const silent_runs = result.digest_sent ? 0 : silentRuns + 1;

    return Response.json({
      success: true,
      ...result,
      silent_runs,
      silence_critical: silenceIsCritical(silentRuns, result.digest_sent),
      max_silent_runs: MAX_SILENT_RUNS,
    });
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
