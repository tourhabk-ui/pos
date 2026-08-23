/**
 * GET /api/cron/channel-sync?secret=...
 * Синхронизирует заказы с внешних маркетплейсов (Tripster, Авито, Sputnik8)
 * Запускать каждые 30 минут
 */

import { syncAllChannels } from '@/lib/channels/channel-manager';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { getCronSecret } from '@/lib/auth/cron';

export async function GET(req: Request) {
  const secret = getCronSecret(req);
  if (!process.env.CRON_SECRET) return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (!timingSafeCompare(secret, process.env.CRON_SECRET)) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  // Heartbeat — ПОСЛЕ работы, по её исходу (§4.0). Прежде 'success' уходил до
  // синхронизации: упавший прогон отдавал 500 и оставался «живым» в журнале.
  const started = Date.now();

  try {
    const results = await syncAllChannels();
    const totalNew = results.reduce((s, r) => s + r.new_orders, 0);
    const allErrors = results.flatMap(r => r.errors);

    recordCronRun('channel-sync', started, 'success', { items: totalNew });
    return Response.json({
      success: true,
      duration_ms: Date.now() - started,
      total_new_orders: totalNew,
      channels: results,
      errors: allErrors.length ? allErrors : undefined,
    });
  } catch (e) {
    const msg = (e as Error).message;
    console.error('[channel-sync] прогон не удался:', msg);
    recordCronRun('channel-sync', started, 'failed', { error: msg });
    return Response.json(
      { success: false, error: msg, duration_ms: Date.now() - started },
      { status: 500 }
    );
  }
}
