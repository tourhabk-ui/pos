import { runWatchdog } from '@/lib/agents/watchdog';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { logAgentRun } from '@/lib/agents/run-logger';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { claimCronWindow, shouldRun, leaseSkipBody } from '@/lib/agents/cron-lease';

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
  if (!shouldRun(lease)) return Response.json(leaseSkipBody('watchdog', 30));

  const started_at = new Date();
  try {
    const result = await runWatchdog();
    // Прогон, в котором часть проверок не смогла выполниться, — не успех.
    // До 31.08 здесь стоял безусловный 'success': при недоступной БД все 18
    // проверок падали, alerts выходил пустым, и история записывала зелёное.
    // Сторож, чей отказ выглядит как «нарушений нет», хуже отсутствия сторожа
    // (§4.0). 'partial' говорит правду: что-то проверено, что-то нет.
    const failedChecks = result.checks.failed.length;
    void logAgentRun({
      agent_id: 'watchdog',
      status: failedChecks > 0 ? 'partial' : 'success',
      started_at,
      duration_ms: Date.now() - started_at.getTime(),
      errors_count: failedChecks,
      error_msg: failedChecks > 0
        ? `не смогли выполниться: ${result.checks.failed.map(f => f.check).join(', ')}`
        : undefined,
      metadata: {
        ...(result as unknown as Record<string, unknown>),
        // Общий ключ `skip_reason` — его детектор бесплодных кронов читает у
        // ЛЮБОГО крона. Без него 02.09 сорок семь прогонов partial (падала
        // checkPendingTransferBookings на отсутствующей таблице) отчитались
        // как «без результата, причина не записана» — класс беды без самой
        // беды. Имена проверок — и есть причина.
        skip_reason: failedChecks > 0
          ? `unverified: ${result.checks.failed.map(f => f.check).join(', ')}`
          : null,
      },
    });
    return Response.json({ success: failedChecks === 0, ...result });
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
