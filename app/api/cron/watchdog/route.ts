import { runWatchdog } from '@/lib/agents/watchdog';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { logAgentRun } from '@/lib/agents/run-logger';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { claimCronWindow, shouldRun, leaseSkipBody } from '@/lib/agents/cron-lease';
import { watchdogRunVerdict, lastWatchdogRun } from '@/lib/agents/watchdog-verdict';

/**
 * GET /api/cron/watchdog
 * Мониторинг платформы: бронирования, операторы, лиды, SOS.
 * Запускать каждые 30 минут.
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

  // Планировщиков у этого крона может быть трое (GitHub, cron-job.org,
  // супервизор контейнера). Без аренды владелец получал бы один и тот же
  // алерт в Telegram дважды.
  const lease = await claimCronWindow('watchdog', 30, 'external');
  if (!shouldRun(lease)) {
    // Окно занято — работу делает другой планировщик. Вторая нога при этом
    // не слепнет: отдаём признаки последнего записанного прогона (без текста
    // тревог), и шаг workflow краснеет, если тот не доставил тревогу или
    // записи давно нет (держатель окна упал).
    return Response.json({ ...leaseSkipBody('watchdog', 30), last_run: await lastWatchdogRun() });
  }

  const started_at = new Date();
  try {
    const result = await runWatchdog();
    // Прогон, в котором часть проверок не смогла выполниться, — не успех.
    // До 31.08 здесь стоял безусловный 'success': при недоступной БД все 18
    // проверок падали, alerts выходил пустым, и история записывала зелёное.
    // Сторож, чей отказ выглядит как «нарушений нет», хуже отсутствия сторожа
    // (§4.0). 'partial' говорит правду: что-то проверено, что-то нет.
    // И недоставка — не успех (23.11): тревога, которую Telegram не принял,
    // записывалась зелёным прогоном, и немой сторож был неотличим от
    // спокойного. Правило статуса — `watchdogRunVerdict`.
    const failedChecks = result.checks.failed.length;
    const verdict = watchdogRunVerdict(result);
    void logAgentRun({
      agent_id: 'watchdog',
      status: verdict.status,
      started_at,
      duration_ms: Date.now() - started_at.getTime(),
      // Мера работы (перепись пользы агентов, 05.11): проверено — сколько
      // проверок отработало, создано — сколько тревог собрано. Без них прогон
      // в журнале был «успех без чисел», и польза сторожа не читалась.
      items_processed: result.checks.total - failedChecks,
      items_created: result.alerts.length,
      errors_count: verdict.errorsCount,
      error_msg: verdict.errorMsg,
      metadata: {
        ...(result as unknown as Record<string, unknown>),
        // Общий ключ `skip_reason` — его детектор бесплодных кронов читает у
        // ЛЮБОГО крона. Без него 02.09 сорок семь прогонов partial (падала
        // checkPendingTransferBookings на отсутствующей таблице) отчитались
        // как «без результата, причина не записана» — класс беды без самой
        // беды. Имена проверок — и есть причина.
        skip_reason: verdict.skipReason,
      },
    });
    return Response.json({ success: verdict.ok, ...result });
  } catch (err) {
    void logAgentRun({
      agent_id: 'watchdog',
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
