/**
 * GET /api/cron/telegram-webhook-watchdog
 * Проверяет, что вебхук бота указывает на актуальный URL.
 * При сбое — переустанавливает вебхук и пишет алерт владельцу.
 * С 15.10 читает и ошибку доставки, которую записал Telegram: повтор от
 * проверки к проверке или копящаяся очередь будят владельца (подробно —
 * `judgeDeliveryError`). Прошлую проверку берёт из `agent_run_history`.
 * Рекомендуется запускать каждые 30 минут.
 */

import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { checkAndRestoreWebhook, readPreviousDeliveryCheck } from '@/lib/telegram/operator-availability';
import { pool } from '@/lib/db-pool';
import { claimCronWindow, shouldRun, leaseSkipBody } from '@/lib/agents/cron-lease';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const secret = getCronSecret(req);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return Response.json({ error: 'Unauthorized', ...diagnoseCronAuth(req) }, { status: 401 });
  }

  const lease = await claimCronWindow('telegram-webhook-watchdog', 30, 'external');
  if (!shouldRun(lease)) return Response.json(leaseSkipBody('telegram-webhook-watchdog', 30));

  const startedAt = new Date();
  const t0 = Date.now();

  const previous = await readPreviousDeliveryCheck();
  const result = await checkAndRestoreWebhook({ previous });

  const durationMs = Date.now() - t0;
  const agentStatus = result.status === 'failed' ? 'failed' : 'success';

  // Запись ждём: по ней следующая проверка узнаёт повтор ошибки доставки.
  // Отказ не глушится (§4.0) — без записи повтор не будет узнан.
  try {
    await pool.query(
      `INSERT INTO agent_run_history (agent_id, status, started_at, ended_at, duration_ms, metadata)
       VALUES ('telegram-webhook-watchdog', $1, $2, NOW(), $3, $4)`,
      [agentStatus, startedAt, durationMs, JSON.stringify(result)],
    );
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'нет кода';
    console.error(`[telegram-webhook-watchdog] прогон не записан в agent_run_history (SQLSTATE ${code}):`, e instanceof Error ? e.message : e);
  }

  return Response.json({ ok: result.status !== 'failed', duration_ms: durationMs, ...result });
}
