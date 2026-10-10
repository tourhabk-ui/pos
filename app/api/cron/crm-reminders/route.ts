/**
 * GET /api/cron/crm-reminders — напоминания партнёру (CRM #2325). Шаг
 * cron-safety-heartbeat.yml, каждые 30 минут. Два прогона в одном шаге:
 *  - о сроке задачи (1в-2, `lib/crm/reminders.ts`) — поля в корне ответа;
 *  - о входящем без ответа 2 часа (1г-2, `lib/crm/inbox-reminders.ts`) —
 *    поле `inbox`.
 * Общие правила: тихие часы 22–08 по Камчатке, канал из `reachForPartner`,
 * ПД только в MAX, три исхода записываются. Ответ — только числа.
 *
 * Исход прогона:
 *  - 500 — база не ответила;
 *  - 502 — было кому напомнить, но ни один партнёр не обработан (в любом
 *    из двух прогонов), или вид входящих не прочитался: шаг краснеет, а не
 *    числится успехом;
 *  - 200 — остальное, включая тихие часы и «напоминать некому».
 */
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { runTaskReminders } from '@/lib/crm/reminders';
import { runInboxReminders } from '@/lib/crm/inbox-reminders';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const secret = getCronSecret(req);
  if (!process.env.CRON_SECRET) return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (!timingSafeCompare(secret, process.env.CRON_SECRET)) return Response.json({ error: 'Unauthorized', ...diagnoseCronAuth(req) }, { status: 401 });

  const started = Date.now();
  try {
    const now = new Date();
    const r = await runTaskReminders(now);
    const inbox = await runInboxReminders(now);
    const stalled = (x: { sent_max: number; sent_stub: number; unreachable: number; failed: number; reach_unknown: number }) =>
      x.failed + x.reach_unknown > 0 && x.sent_max + x.sent_stub + x.unreachable === 0;
    const problems = [
      stalled(r) && `задачи: не обработан ни один партнёр из ${r.partners}`,
      stalled(inbox) && `входящие: не обработан ни один партнёр из ${inbox.partners}`,
      inbox.failed_kinds.length > 0 && `входящие не прочитались: ${inbox.failed_kinds.join(', ')}`,
    ].filter((x): x is string => typeof x === 'string');
    if (problems.length > 0) {
      recordCronRun('crm-reminders', started, 'failed', { error: problems.join('; ') });
      return Response.json(
        { success: false, error: problems.join('; '), duration_ms: Date.now() - started, ...r, inbox },
        { status: 502 },
      );
    }
    recordCronRun('crm-reminders', started, 'success', { items: r.sent_max + r.sent_stub + inbox.sent_max + inbox.sent_stub });
    return Response.json({ success: true, duration_ms: Date.now() - started, ...r, inbox });
  } catch (e) {
    const code = (e as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[crm-reminders] прогон не удался, SQLSTATE', code);
    recordCronRun('crm-reminders', started, 'failed', { error: `SQLSTATE ${code}` });
    return Response.json({ success: false, error: 'Прогон не удался', duration_ms: Date.now() - started }, { status: 500 });
  }
}
