/**
 * lib/crm/reminders.ts — напоминание партнёру о сроке задачи (CRM 1в-2, #2325).
 *
 * Подошёл срок — одно сообщение партнёру со всеми его задачами, у которых
 * он подошёл с прошлого прогона. Зовёт крон `GET /api/cron/crm-reminders`
 * (шаг cron-safety-heartbeat.yml, каждые 30 минут).
 *
 * Правила:
 *  - **Тихие часы 22:00–08:00 по Камчатке.** CRM ведёт время партнёра по
 *    Камчатке (`lib/crm/task-time.ts`); задача со сроком в 23:00 приходит
 *    в 08:12, а не будит. Срок, наступивший ночью, догоняется утром.
 *  - **Канал — один адрес партнёра** (`reachForPartner`), доставка — через
 *    единственную дверь для ПД (`sendPdAlert`): имена клиентов и заголовки
 *    задач уходят только в MAX; в Telegram — заглушка без них.
 *  - **Три исхода, не два (§4.0).** Доставлено в MAX, ушла заглушка, слать
 *    некуда — записывается в `reminder_channel` и видно на экране задач.
 *    Отказ доставки не записывается: следующий прогон пробует снова.
 *    «Не смог прочитать адрес» — тоже повтор, а не «каналов нет».
 *  - **Окно — 7 суток.** Пропущенный прогон догонит следующий, но задача,
 *    просроченная неделю назад, — не повод будить сегодня. Задача, заведённая
 *    уже просроченной («перезвонить вчера»), не напоминается: её срок
 *    партнёр видел, когда писал.
 */
import { pool } from '@/lib/db-pool';
import { KAMCHATKA_UTC_OFFSET_HOURS } from '@/lib/analytics/kamchatka-day';
import { ROLE_HUB } from '@/lib/auth/role-routes';
import { escapeHtml } from '@/lib/text/escape-html';
import { reachForPartner, type PartnerReach } from '@/lib/partners/reach';
import { sendPdAlert, type PdAlertParams, type PdAlertResult } from '@/lib/notifications/pd-alert';
import type { ReminderChannel } from '@/lib/crm/tasks';

interface Queryable {
  query: typeof pool.query;
}

export const QUIET_FROM_HOUR = 22;
export const QUIET_TO_HOUR = 8;
export const REMIND_WINDOW_DAYS = 7;
export const BATCH_LIMIT = 500;
export const SHOWN_PER_MESSAGE = 10;

const SITE = 'https://vedarai.ru';

/** Час по Камчатке: UTC+12, летнего времени нет. */
export function kamchatkaHour(now: Date): number {
  return (now.getUTCHours() + KAMCHATKA_UTC_OFFSET_HOURS) % 24;
}

export function isQuietHour(now: Date): boolean {
  const h = kamchatkaHour(now);
  return h >= QUIET_FROM_HOUR || h < QUIET_TO_HOUR;
}

export interface DueTaskRow {
  id: string;
  partner_id: string;
  category: string;
  title: string;
  due_at: Date;
  contact_name: string | null;
}

/**
 * Задачи, у которых подошёл срок и о которых ещё не напоминали. Скоуп
 * партнёра здесь не нужен — крон обходит всех; он стоит в записи исхода.
 */
export const DUE_TASKS_SQL = `
  SELECT t.id, t.partner_id, p.category, t.title, t.due_at, c.display_name AS contact_name
    FROM crm_tasks t
    JOIN partners p ON p.id = t.partner_id
    LEFT JOIN crm_contacts c ON c.id = t.contact_id
   WHERE t.done_at IS NULL
     AND t.reminded_at IS NULL
     AND t.due_at <= $1::timestamptz
     AND t.due_at > $1::timestamptz - ($2::int * INTERVAL '1 day')
     AND t.due_at > t.created_at
   ORDER BY t.partner_id, t.due_at
   LIMIT $3`;

/** Исход пишется только открытым и ещё не обработанным — гонка с «выполнено» безвредна. */
export const MARK_REMINDED_SQL = `
  UPDATE crm_tasks
     SET reminded_at = NOW(), reminder_channel = $3
   WHERE partner_id = $1
     AND id = ANY($2::uuid[])
     AND done_at IS NULL
     AND reminded_at IS NULL`;

function dueLabel(d: Date): string {
  return d.toLocaleString('ru-RU', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kamchatka',
  });
}

/** Ссылка на экран «Задачи» кабинета партнёра по его категории. */
export function tasksUrl(category: string): string {
  const hub = ROLE_HUB[category];
  return hub ? `${SITE}${hub}/tasks` : `${SITE}/hub`;
}

function tasksWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'задача';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'задачи';
  return 'задач';
}

/**
 * Сообщение партнёру. `text` — с заголовками задач и именами клиентов,
 * уходит только в MAX; `stub` — без них, для Telegram. Всё, что ввёл
 * человек, экранируется: HTML разбирает мессенджер.
 */
export function reminderMessage(tasks: readonly DueTaskRow[]): Pick<PdAlertParams, 'text' | 'stub' | 'buttons'> {
  const n = tasks.length;
  const head = `<b>Подошёл срок: ${n} ${tasksWord(n)}</b>`;
  const lines = tasks.slice(0, SHOWN_PER_MESSAGE).map((t) => {
    const who = t.contact_name ? ` — ${escapeHtml(t.contact_name)}` : '';
    return `• ${escapeHtml(t.title)}${who} · срок ${escapeHtml(dueLabel(t.due_at))}`;
  });
  const rest = n - lines.length;
  if (rest > 0) lines.push(`…и ещё ${rest}`);
  const url = tasksUrl(tasks[0]?.category ?? '');
  return {
    text: [head, ...lines].join('\n'),
    stub: `${head}\nЧто именно — в кабинете: заголовки задач и имена клиентов в Telegram не пересылаются.`,
    buttons: [{ text: 'Открыть задачи', url }],
  };
}

export interface ReminderReport {
  quiet: boolean;
  /** Задач со сроком в этом прогоне. */
  due: number;
  /** Дальше — по партнёрам. */
  partners: number;
  sent_max: number;
  sent_stub: number;
  unreachable: number;
  failed: number;
  reach_unknown: number;
  /** Упёрлись в BATCH_LIMIT — остаток в следующем прогоне. */
  truncated: boolean;
}

export interface ReminderDeps {
  db?: Queryable;
  reach?: (partnerId: string) => Promise<PartnerReach | null>;
  send?: (p: PdAlertParams) => Promise<PdAlertResult>;
}

const CHANNEL_OF: Readonly<Record<'max' | 'telegram-stub', ReminderChannel>> = {
  max: 'max',
  'telegram-stub': 'telegram_stub',
};

/** Один прогон напоминаний. Отказ базы — исключение: крон отвечает 500. */
export async function runTaskReminders(now: Date, deps: ReminderDeps = {}): Promise<ReminderReport> {
  const db = deps.db ?? pool;
  const reach = deps.reach ?? reachForPartner;
  const send = deps.send ?? sendPdAlert;
  const report: ReminderReport = {
    quiet: false, due: 0, partners: 0, sent_max: 0, sent_stub: 0, unreachable: 0, failed: 0, reach_unknown: 0, truncated: false,
  };
  if (isQuietHour(now)) return { ...report, quiet: true };

  const { rows } = await db.query<DueTaskRow>(DUE_TASKS_SQL, [now.toISOString(), REMIND_WINDOW_DAYS, BATCH_LIMIT]);
  report.due = rows.length;
  report.truncated = rows.length >= BATCH_LIMIT;

  const byPartner = new Map<string, DueTaskRow[]>();
  for (const r of rows) {
    const list = byPartner.get(r.partner_id);
    if (list) list.push(r);
    else byPartner.set(r.partner_id, [r]);
  }
  report.partners = byPartner.size;

  const mark = (partnerId: string, tasks: DueTaskRow[], channel: ReminderChannel) =>
    db.query(MARK_REMINDED_SQL, [partnerId, tasks.map((t) => t.id), channel]);

  for (const [partnerId, tasks] of byPartner) {
    const to = await reach(partnerId);
    if (!to) {
      // reachForPartner уже записал SQLSTATE; «не знаю адреса» — не «адреса нет».
      report.reach_unknown += 1;
      continue;
    }
    if (!to.reachable) {
      await mark(partnerId, tasks, 'unreachable');
      report.unreachable += 1;
      continue;
    }
    const res = await send({ ...reminderMessage(tasks), to: { maxChatId: to.maxChatId, telegramChatId: to.telegramChatId } });
    if (res.channel === 'none') {
      console.error('[crm-reminders] напоминание не доставлено, повтор в следующем прогоне:', res.reason);
      report.failed += 1;
      continue;
    }
    await mark(partnerId, tasks, CHANNEL_OF[res.channel]);
    if (res.channel === 'max') report.sent_max += 1;
    else report.sent_stub += 1;
  }
  return report;
}
