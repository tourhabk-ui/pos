/**
 * GET /api/cron/crm-reminders — напоминания партнёру (CRM #2325). Шаг
 * cron-safety-heartbeat.yml, каждые 30 минут. Три прогона в одном шаге:
 *  - о сроке задачи (1в-2, `lib/crm/reminders.ts`) — поля в корне ответа;
 *  - о входящем без ответа 2 часа (1г-2, `lib/crm/inbox-reminders.ts`) —
 *    поле `inbox`;
 *  - утренняя сводка кабинета в чате, 08–10 по Камчатке, раз в сутки
 *    (30.10, `lib/chat-cabinet/digest.ts`) — поле `digest`.
 * Общие правила: тихие часы 22–08 по Камчатке, канал из `reachForPartner`,
 * ПД только в MAX, исходы записываются. Напоминание о задаче уходит копией и
 * менеджерам команды оператора (CRM 2г, `team_*` в ответе). Ответ — только числа.
 *
 * Исход прогона:
 *  - 500 — база не ответила;
 *  - 502 — было кому напомнить, но ни один партнёр не обработан (в любом
 *    из трёх прогонов), вид входящих или список кабинетов для сводки не
 *    прочитался: шаг краснеет, а не числится успехом;
 *  - 200 — остальное, включая тихие часы и «напоминать некому».
 */
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { runTaskReminders } from '@/lib/crm/reminders';
import { runInboxReminders } from '@/lib/crm/inbox-reminders';
import { runMorningDigest } from '@/lib/chat-cabinet/digest';

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
    const digest = await runMorningDigest(now);
    // team_only — напоминание записано: дошло до менеджеров команды (CRM 2г).
    const stalled = (x: { sent_max: number; sent_stub: number; unreachable: number; failed: number; reach_unknown: number; team_only?: number }) =>
      x.failed + x.reach_unknown > 0 && x.sent_max + x.sent_stub + x.unreachable + (x.team_only ?? 0) === 0;
    const problems = [
      stalled(r) && `задачи: не обработан ни один партнёр из ${r.partners}`,
      stalled(inbox) && `входящие: не обработан ни один партнёр из ${inbox.partners}`,
      inbox.failed_kinds.length > 0 && `входящие не прочитались: ${inbox.failed_kinds.join(', ')}`,
      // Сводка: было что разослать, а не ушла ни одна и ни одна строка не записана.
      digest.failed + digest.read_failed > 0
        && digest.sent_max + digest.sent_tg + digest.sent_stub + digest.empty + digest.unreachable === 0
        && `сводка: не обработан ни один кабинет из ${digest.candidates}`,
      digest.query_failed && 'сводка: список кабинетов не прочитался',
    ].filter((x): x is string => typeof x === 'string');
    if (problems.length > 0) {
      recordCronRun('crm-reminders', started, 'failed', { error: problems.join('; ') });
      return Response.json(
        { success: false, error: problems.join('; '), duration_ms: Date.now() - started, ...r, inbox, digest },
        { status: 502 },
      );
    }
    recordCronRun('crm-reminders', started, 'success', {
      items: r.sent_max + r.sent_stub + r.team_only + inbox.sent_max + inbox.sent_stub
        + digest.sent_max + digest.sent_tg + digest.sent_stub,
    });
    return Response.json({ success: true, duration_ms: Date.now() - started, ...r, inbox, digest });
  } catch (e) {
    const code = (e as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[crm-reminders] прогон не удался, SQLSTATE', code);
    recordCronRun('crm-reminders', started, 'failed', { error: `SQLSTATE ${code}` });
    return Response.json({ success: false, error: 'Прогон не удался', duration_ms: Date.now() - started }, { status: 500 });
  }
}
