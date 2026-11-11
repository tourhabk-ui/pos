/**
 * GET /api/cron/answer-notices (Authorization: Bearer <CRON_SECRET>)
 *
 * Добивка сообщений человеку после ответа туроператора кнопкой (план «после
 * отказа», этап 2б; lib/requests/answer-notice). Обычный путь — сразу в
 * нажатии оператора; сюда попадает только то, что нажатие не довело:
 *  - обрыв посреди отправки (строка «ждёт» после 5-минутного захвата);
 *  - недоставленное, о котором менеджеру Ведара ничего не дошло;
 *  - дошедшее после письма менеджеру — «звонить не нужно».
 * Повторного сообщения человеку по таймеру нет: срок наугад правило
 * владельца 11.11 запрещает.
 *
 * Зовут два планировщика — супервизор start.js (SAFETY_JOBS) и шаг
 * cron-safety-heartbeat.yml; аренда окна 30 мин не даёт им прогнать одно и
 * то же дважды.
 */

import { timingSafeCompare } from '@/lib/security/timing-safe';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { claimCronWindow, shouldRun, leaseSkipBody } from '@/lib/agents/cron-lease';
import { runAnswerNotices } from '@/lib/requests/answer-notice';

export const dynamic = 'force-dynamic';
/** Строки начинаются до 40-й секунды, худшая идёт 125 с (NOTICE_ROW_WORST_MS). */
export const maxDuration = 180;

export async function GET(req: Request) {
  const secret = getCronSecret(req);
  if (!process.env.CRON_SECRET) return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (!timingSafeCompare(secret, process.env.CRON_SECRET)) return Response.json({ error: 'Unauthorized', ...diagnoseCronAuth(req) }, { status: 401 });

  const lease = await claimCronWindow('answer-notices', 30, 'external');
  if (!shouldRun(lease)) return Response.json(leaseSkipBody('answer-notices', 30));

  const started = Date.now();
  const r = await runAnswerNotices();
  if (r.status !== 'ok') {
    // Причина и SQLSTATE — в логе модуля; прогон с отказом базы не «успех».
    recordCronRun('answer-notices', started, 'failed', { error: 'db_error' });
    return Response.json({ success: false, duration_ms: Date.now() - started, ...r }, { status: 500 });
  }
  recordCronRun('answer-notices', started, 'success', { items: r.picked });
  return Response.json({ success: true, duration_ms: Date.now() - started, ...r });
}
