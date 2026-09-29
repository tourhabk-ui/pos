/**
 * GET /api/cron/seat-requests-expire (Authorization: Bearer <CRON_SECRET>)
 *
 * Закрыть запросы мест, на которые оператор не ответил за 2 часа, и сообщить
 * туристам (lib/seat-requests/service, expireOverdue). Зовёт
 * cron-safety-heartbeat.yml каждые 30 минут.
 *
 * Срок и без уборщика виден читателям — страница статуса считает его от
 * deadline_at, — поэтому опоздание планировщика не показывает туристу «ждём»
 * через три часа. Уборщик нужен для базы и для сообщения в мессенджер.
 */

import { timingSafeCompare } from '@/lib/security/timing-safe';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { expireOverdue } from '@/lib/seat-requests/service';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const secret = getCronSecret(req);
  if (!process.env.CRON_SECRET) return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (!timingSafeCompare(secret, process.env.CRON_SECRET)) return Response.json({ error: 'Unauthorized', ...diagnoseCronAuth(req) }, { status: 401 });

  const started = Date.now();
  try {
    const r = await expireOverdue();
    // Не дошло туристу — не провал прогона: страница статуса честна и без
    // сообщения. Но число названо, а не спрятано.
    recordCronRun('seat-requests-expire', started, 'success', { items: r.expired });
    return Response.json({ success: true, duration_ms: Date.now() - started, ...r });
  } catch (e) {
    const msg = (e as Error).message;
    console.error('[seat-requests-expire] прогон не удался:', msg);
    recordCronRun('seat-requests-expire', started, 'failed', { error: msg });
    return Response.json({ success: false, error: msg, duration_ms: Date.now() - started }, { status: 500 });
  }
}
