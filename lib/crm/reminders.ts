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
 *  - **Копия — менеджерам команды оператора** (решение владельца 13.10,
 *    `notifyTeam`, lib/operators/team-notify): тот же текст, ПД только в MAX
 *    менеджера. Копия уходит в том прогоне, в котором напоминание
 *    записывается: отказ доставки кабинету и «адрес не прочитан» повторяются
 *    следующим прогоном вместе с копией — иначе менеджер получал бы одно и
 *    то же каждые полчаса.
 *  - **Четыре исхода (§4.0).** Доставлено в MAX, ушла заглушка, у кабинета
 *    канала нет, но дошло до менеджеров (`team`), слать некуда — пишется в
 *    `reminder_channel` и видно на экране задач. Отказ доставки не
 *    записывается: следующий прогон пробует снова. «Не смог прочитать адрес»
 *    — тоже повтор, а не «каналов нет».
 *  - **«Выполнено» кнопкой — только в MAX** (план «гид в чате», шаг 9): под
 *    каждой показанной задачей кнопка `tk:d:<uuid>` (lib/crm/chat-task-press),
 *    нажатие отмечает задачу тем же `completeTask`, что кабинет. Заглушка
 *    Telegram кнопок-действий не несёт — их выбрасывает `sendPdAlert`; копия
 *    менеджерам — без них: в чате менеджера чат кабинета не найдётся, и
 *    кнопка была бы мёртвой.
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
import { notifyTeam, type TeamMessage, type TeamNotifyResult } from '@/lib/operators/team-notify';
import type { ReminderChannel } from '@/lib/crm/tasks';
import { taskDoneButton } from '@/lib/crm/chat-task-press';

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

/** Напоминание кабинету: ссылка в кабинет и «Выполнено» под каждой показанной задачей. */
export type ReminderMessage = Required<Pick<PdAlertParams, 'text' | 'stub' | 'buttons'>>;

/**
 * Сообщение партнёру. `text` — с заголовками задач и именами клиентов,
 * уходит только в MAX; `stub` — без них, для Telegram. Всё, что ввёл
 * человек, экранируется: HTML разбирает мессенджер. Задач несколько — строки
 * пронумерованы, и кнопка называет номер: два «Перезвонить» различает только
 * он.
 */
export function reminderMessage(tasks: readonly DueTaskRow[]): ReminderMessage {
  const n = tasks.length;
  const head = `<b>Подошёл срок: ${n} ${tasksWord(n)}</b>`;
  const shown = tasks.slice(0, SHOWN_PER_MESSAGE);
  const numbered = shown.length > 1;
  const lines = shown.map((t, i) => {
    const who = t.contact_name ? ` — ${escapeHtml(t.contact_name)}` : '';
    return `${numbered ? `${i + 1}.` : '•'} ${escapeHtml(t.title)}${who} · срок ${escapeHtml(dueLabel(t.due_at))}`;
  });
  const rest = n - lines.length;
  if (rest > 0) lines.push(`…и ещё ${rest}`);
  const url = tasksUrl(tasks[0]?.category ?? '');
  return {
    text: [head, ...lines].join('\n'),
    stub: `${head}\nЧто именно — в кабинете: заголовки задач и имена клиентов в Telegram не пересылаются.`,
    buttons: [
      ...shown.map((t, i) => taskDoneButton(t, numbered ? i + 1 : null)),
      { text: 'Открыть задачи', url },
    ],
  };
}

/** Копия менеджерам команды: тот же текст, только ссылки — «Выполнено» в их чате было бы мёртвой кнопкой. */
export function teamCopyOf(msg: ReminderMessage): Required<TeamMessage> {
  return {
    text: msg.text,
    stub: msg.stub,
    buttons: msg.buttons.filter((b): b is { text: string; url: string } => 'url' in b),
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
  /** Команда оператора (CRM 2г): у кабинета канала нет — дошло только до менеджеров. */
  team_only: number;
  /** Менеджерам: ПД дошли в MAX / только заглушка в Telegram (по людям). */
  team_sent_max: number;
  team_sent_stub: number;
  /** Команду не прочитать — копия не ушла, напоминание кабинету записано. */
  team_unknown: number;
  /** Упёрлись в BATCH_LIMIT — остаток в следующем прогоне. */
  truncated: boolean;
}

export interface ReminderDeps {
  db?: Queryable;
  reach?: (partnerId: string) => Promise<PartnerReach | null>;
  send?: (p: PdAlertParams) => Promise<PdAlertResult>;
  team?: (partnerId: string, msg: TeamMessage, what: string) => Promise<TeamNotifyResult>;
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
  const team = deps.team ?? notifyTeam;
  const report: ReminderReport = {
    quiet: false, due: 0, partners: 0, sent_max: 0, sent_stub: 0, unreachable: 0, failed: 0, reach_unknown: 0,
    team_only: 0, team_sent_max: 0, team_sent_stub: 0, team_unknown: 0, truncated: false,
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
    const message = reminderMessage(tasks);
    // Команда есть только у кабинета оператора (CRM 2г). Зовётся лишь там,
    // где напоминание сейчас будет записано, — см. шапку модуля.
    const copyToTeam = async (): Promise<number> => {
      if (tasks[0]?.category !== 'operator') return 0;
      const r = await team(partnerId, teamCopyOf(message), `напоминание о задачах (${tasks.length})`);
      if (r.state === 'unknown') {
        report.team_unknown += 1;
        return 0;
      }
      report.team_sent_max += r.delivered;
      report.team_sent_stub += r.stubbed;
      return r.delivered + r.stubbed;
    };
    if (!to.reachable) {
      const reached = await copyToTeam();
      await mark(partnerId, tasks, reached > 0 ? 'team' : 'unreachable');
      if (reached > 0) report.team_only += 1;
      else report.unreachable += 1;
      continue;
    }
    const res = await send({ ...message, to: { maxChatId: to.maxChatId, telegramChatId: to.telegramChatId } });
    if (res.channel === 'none') {
      console.error('[crm-reminders] напоминание не доставлено, повтор в следующем прогоне:', res.reason);
      report.failed += 1;
      continue;
    }
    await copyToTeam();
    await mark(partnerId, tasks, CHANNEL_OF[res.channel]);
    if (res.channel === 'max') report.sent_max += 1;
    else report.sent_stub += 1;
  }
  return report;
}
