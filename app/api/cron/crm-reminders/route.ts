/**
 * GET /api/cron/crm-reminders — напоминание партнёру о сроке задачи
 * (CRM 1в-2, #2325). Шаг cron-safety-heartbeat.yml, каждые 30 минут.
 *
 * Правила — в `lib/crm/reminders.ts`: тихие часы 22–08 по Камчатке, канал
 * из `reachForPartner`, ПД только в MAX, три исхода в `reminder_channel`.
 * Ответ — только числа, без имён и заголовков.
 *
 * Исход прогона:
 *  - 500 — база не ответила;
 *  - 502 — было кому напомнить, но ни один партнёр не обработан (все
 *    доставки отказали или адреса не прочитались): шаг краснеет, а не
 *    числится успехом;
 *  - 200 — остальное, включая тихие часы и «напоминать некому».
 */
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { runTaskReminders } from '@/lib/crm/reminders';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const secret = getCronSecret(req);
  if (!process.env.CRON_SECRET) return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (!timingSafeCompare(secret, process.env.CRON_SECRET)) return Response.json({ error: 'Unauthorized', ...diagnoseCronAuth(req) }, { status: 401 });

  const started = Date.now();
  try {
    const r = await runTaskReminders(new Date());
    const handled = r.sent_max + r.sent_stub + r.unreachable;
    const missed = r.failed + r.reach_unknown;
    if (missed > 0 && handled === 0) {
      recordCronRun('crm-reminders', started, 'failed', { error: `не обработан ни один партнёр из ${r.partners}` });
      return Response.json({ success: false, error: 'Напоминания не доставлены ни одному партнёру', duration_ms: Date.now() - started, ...r }, { status: 502 });
    }
    recordCronRun('crm-reminders', started, 'success', { items: r.sent_max + r.sent_stub });
    return Response.json({ success: true, duration_ms: Date.now() - started, ...r });
  } catch (e) {
    const code = (e as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[crm-reminders] прогон не удался, SQLSTATE', code);
    recordCronRun('crm-reminders', started, 'failed', { error: `SQLSTATE ${code}` });
    return Response.json({ success: false, error: 'Прогон не удался', duration_ms: Date.now() - started }, { status: 500 });
  }
}
