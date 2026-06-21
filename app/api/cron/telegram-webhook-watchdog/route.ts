/**
 * GET /api/cron/telegram-webhook-watchdog
 * Проверяет, что вебхук бота указывает на актуальный URL.
 * При сбое — переустанавливает вебхук и пишет алерт владельцу.
 * Рекомендуется запускать каждые 30 минут.
 */

import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { checkAndRestoreWebhook } from '@/lib/telegram/operator-availability';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const secret = getCronSecret(req);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = new Date();
  const t0 = Date.now();

  const result = await checkAndRestoreWebhook();

  const durationMs = Date.now() - t0;
  const agentStatus = result.status === 'failed' ? 'failed' : 'success';

  pool.query(
    `INSERT INTO agent_run_history (agent_id, status, started_at, ended_at, duration_ms, metadata)
     VALUES ('telegram-webhook-watchdog', $1, $2, NOW(), $3, $4)`,
    [agentStatus, startedAt, durationMs, JSON.stringify(result)],
  ).catch(() => {});

  return Response.json({ ok: result.status !== 'failed', duration_ms: durationMs, ...result });
}
