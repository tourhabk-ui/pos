import { runScoutDigestJournaled } from '@/lib/agents/scout-digest-run';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
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

  try {
    // Журнал пишет общий модуль (lib/agents/scout-digest-run, 04.09): тот же
    // прогон из оркестратора эволюции и из админки раньше в agent_run_history
    // не попадал вовсе, и разбор «почему молчит» видел только ручные запуски.
    // Причина пропуска и улика переживают запрос там же.
    const { result } = await runScoutDigestJournaled('cron');
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
    // Отказ уже в журнале (status failed, trigger cron) — см. scout-digest-run.
    return Response.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
