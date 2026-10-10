/**
 * lib/crm/inbox-reminders.ts — напоминание партнёру о входящем без ответа
 * (CRM 1г-2, #2325). Зовёт тот же крон, что напоминания о задачах
 * (`GET /api/cron/crm-reminders`, шаг cron-safety-heartbeat.yml, 30 минут).
 *
 * Правила:
 *  - **Одна ступень — 2 часа.** Бронь, заказ, места в машине, приглашение
 *    гиду ждут ответа два часа — партнёру одно сообщение со всеми такими
 *    предметами. Через 24 часа о бронях жилья, проката и мест уже пишет
 *    Watchdog (о брони тура — через 48), поэтому окно здесь — до 24 часов:
 *    старше — его дверь, а не наша.
 *  - **Каких предметов нет и почему.** Заявку через 2 часа перераспределяет
 *    `leads-followup` (решение владельца 09.10 «лид да 2 часа»); запрос мест
 *    сам истекает через 2 часа; отзыв не ждёт ответа «быстро».
 *  - **Тихие часы 22:00–08:00 по Камчатке** — те же, что у задач: ночной
 *    предмет догоняется утром.
 *  - **ПД только в MAX** (`sendPdAlert`): имена клиентов — в MAX, в
 *    Telegram — заглушка без них. Названия туров и жилья — не ПД.
 *  - **Три исхода (§4.0)** — max, telegram_stub, unreachable — пишутся в
 *    `crm_inbox_reminders`; отказ доставки строки не пишет и повторяется.
 *    Не прочитался вид — он назван в отчёте, остальные идут своим ходом.
 */
import { pool } from '@/lib/db-pool';
import { ROLE_HUB } from '@/lib/auth/role-routes';
import { escapeHtml } from '@/lib/text/escape-html';
import { reachForPartner, type PartnerReach } from '@/lib/partners/reach';
import { sendPdAlert, type PdAlertParams, type PdAlertResult } from '@/lib/notifications/pd-alert';
import { isQuietHour } from '@/lib/crm/reminders';
import { INBOX_KIND_LABELS } from '@/lib/crm/inbox-kinds';

interface Queryable {
  query: typeof pool.query;
}

export const INBOX_REMIND_KINDS = [
  'operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking', 'guide_invite',
] as const;
export type InboxRemindKind = (typeof INBOX_REMIND_KINDS)[number];

/** Через сколько минут ожидания напоминаем. */
export const INBOX_REMIND_AFTER_MINUTES = 120;
/** Старше — дверь Watchdog (24 ч для жилья, проката, мест; 48 ч для тура). */
export const INBOX_REMIND_WINDOW_HOURS = 24;
export const INBOX_SHOWN_PER_MESSAGE = 10;

const SITE = 'https://vedarai.ru';

/** Не напоминали ли уже — по этому партнёру и этому предмету. */
function notReminded(partnerExpr: string, kind: InboxRemindKind, idExpr: string): string {
  return `NOT EXISTS (SELECT 1 FROM crm_inbox_reminders r
                       WHERE r.partner_id = ${partnerExpr} AND r.item_kind = '${kind}' AND r.item_id = ${idExpr})`;
}

/** Ждёт ответа дольше ступени, но меньше окна. $1 — «сейчас», $2 — минут, $3 — часов окна. */
function waitedWindow(createdExpr: string): string {
  return `${createdExpr} <= $1::timestamptz - ($2::int * INTERVAL '1 minute')
          AND ${createdExpr} > $1::timestamptz - ($3::int * INTERVAL '1 hour')`;
}

function contactJoin(kind: InboxRemindKind, partnerExpr: string, idExpr: string): string {
  return `LEFT JOIN crm_contact_links cl ON cl.partner_id = ${partnerExpr} AND cl.source_kind = '${kind}' AND cl.source_id = ${idExpr}
          LEFT JOIN crm_contacts cc ON cc.id = cl.contact_id AND cc.partner_id = ${partnerExpr}`;
}

/**
 * По всем партнёрам сразу — крон обходит всех; скоуп партнёра стоит в
 * строке ответа и в записи исхода. Форма строки одна у всех видов.
 */
export const INBOX_REMIND_SQL: Readonly<Record<InboxRemindKind, string>> = {
  operator_booking: `
    SELECT t.operator_id AS partner_id, p.category, b.id::text AS item_id, b.created_at,
           t.title, b.booking_date::text AS item_date, cc.display_name AS contact_name
      FROM operator_bookings b
      JOIN operator_tours t ON t.id = b.operator_tour_id
      JOIN partners p ON p.id = t.operator_id
      ${contactJoin('operator_booking', 't.operator_id', 'b.id::text')}
     WHERE b.booking_status = 'new' AND b.deleted_at IS NULL
       AND ${waitedWindow('b.created_at')}
       AND ${notReminded('t.operator_id', 'operator_booking', 'b.id::text')}`,

  accommodation_booking: `
    SELECT a.partner_id, p.category, ab.id::text AS item_id, ab.created_at,
           a.name AS title, ab.check_in_date::text AS item_date, cc.display_name AS contact_name
      FROM accommodation_bookings ab
      JOIN accommodations a ON a.id = ab.accommodation_id
      JOIN partners p ON p.id = a.partner_id
      ${contactJoin('accommodation_booking', 'a.partner_id', 'ab.id::text')}
     WHERE ab.status = 'pending'
       AND ${waitedWindow('ab.created_at')}
       AND ${notReminded('a.partner_id', 'accommodation_booking', 'ab.id::text')}`,

  gear_rental: `
    SELECT gi.partner_id, p.category, gr.id::text AS item_id, gr.created_at,
           gi.name AS title, gr.start_date::text AS item_date, cc.display_name AS contact_name
      FROM gear_rentals gr
      JOIN gear_items gi ON gi.id = gr.gear_id
      JOIN partners p ON p.id = gi.partner_id
      ${contactJoin('gear_rental', 'gi.partner_id', 'gr.id::text')}
     WHERE gr.status = 'pending'
       AND ${waitedWindow('gr.created_at')}
       AND ${notReminded('gi.partner_id', 'gear_rental', 'gr.id::text')}`,

  transfer_seat_booking: `
    SELECT v.partner_id, p.category, sb.id::text AS item_id, sb.created_at,
           (tr.from_text || ' — ' || tr.to_text) AS title, tr.trip_date::text AS item_date, cc.display_name AS contact_name
      FROM transfer_seat_bookings sb
      JOIN transfer_trips tr ON tr.id = sb.trip_id
      JOIN transfer_fleet_vehicles v ON v.id = tr.vehicle_id
      JOIN partners p ON p.id = v.partner_id
      ${contactJoin('transfer_seat_booking', 'v.partner_id', 'sb.id::text')}
     WHERE sb.status = 'requested'
       AND ${waitedWindow('sb.created_at')}
       AND ${notReminded('v.partner_id', 'transfer_seat_booking', 'sb.id::text')}`,

  guide_invite: `
    SELECT i.guide_partner_id AS partner_id, p.category, i.id::text AS item_id, i.created_at,
           op.name AS title, NULL::text AS item_date, NULL::text AS contact_name
      FROM guide_operator_invites i
      JOIN partners p ON p.id = i.guide_partner_id
      JOIN partners op ON op.id = i.operator_id
     WHERE i.status = 'pending'
       AND ${waitedWindow('i.created_at')}
       AND ${notReminded('i.guide_partner_id', 'guide_invite', 'i.id::text')}`,
};

/** Исход — одной строкой на предмет; повтор и гонка двух прогонов безвредны. */
export const MARK_INBOX_REMINDED_SQL = `
  INSERT INTO crm_inbox_reminders (partner_id, item_kind, item_id, channel)
  SELECT $1, u.kind, u.id, $4
    FROM unnest($2::text[], $3::text[]) AS u(kind, id)
  ON CONFLICT (partner_id, item_kind, item_id) DO NOTHING`;

export interface WaitingRow {
  partner_id: string;
  category: string;
  item_id: string;
  created_at: Date;
  title: string | null;
  item_date: string | null;
  contact_name: string | null;
}

type Item = WaitingRow & { kind: InboxRemindKind };

export function inboxUrl(category: string): string {
  const hub = ROLE_HUB[category];
  return hub ? `${SITE}${hub}/inbox` : `${SITE}/hub`;
}

function shortDate(iso: string | null): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

/**
 * Сообщение партнёру. `text` — с именами клиентов, уходит только в MAX;
 * `stub` — без них, для Telegram. Всё из базы экранируется: HTML разбирает
 * мессенджер, а названия и имена вводили люди.
 */
export function inboxReminderMessage(items: readonly Item[]): Pick<PdAlertParams, 'text' | 'stub' | 'buttons'> {
  const n = items.length;
  const head = `<b>Ждут ответа больше 2 часов: ${n}</b>`;
  const lines = items.slice(0, INBOX_SHOWN_PER_MESSAGE).map((it) => {
    const what = it.title ? ` «${escapeHtml(it.title)}»` : '';
    const when = shortDate(it.item_date);
    const who = it.contact_name ? ` — ${escapeHtml(it.contact_name)}` : '';
    return `• ${INBOX_KIND_LABELS[it.kind]}${what}${when ? ` · ${when}` : ''}${who}`;
  });
  const rest = n - lines.length;
  if (rest > 0) lines.push(`…и ещё ${rest}`);
  return {
    text: [head, ...lines].join('\n'),
    stub: `${head}\nЧто именно — в кабинете, во «Входящих»: имена клиентов в Telegram не пересылаются.`,
    buttons: [{ text: 'Открыть входящие', url: inboxUrl(items[0]?.category ?? '') }],
  };
}

export interface InboxReminderReport {
  quiet: boolean;
  /** Предметов, о которых пора напомнить. */
  due: number;
  partners: number;
  sent_max: number;
  sent_stub: number;
  unreachable: number;
  failed: number;
  reach_unknown: number;
  /** Виды, которые не прочитались: о них в этом прогоне не напомнили. */
  failed_kinds: InboxRemindKind[];
}

export interface InboxReminderDeps {
  db?: Queryable;
  reach?: (partnerId: string) => Promise<PartnerReach | null>;
  send?: (p: PdAlertParams) => Promise<PdAlertResult>;
}

const CHANNEL_OF = { max: 'max', 'telegram-stub': 'telegram_stub' } as const;

export async function runInboxReminders(now: Date, deps: InboxReminderDeps = {}): Promise<InboxReminderReport> {
  const db = deps.db ?? pool;
  const reach = deps.reach ?? reachForPartner;
  const send = deps.send ?? sendPdAlert;
  const report: InboxReminderReport = {
    quiet: false, due: 0, partners: 0, sent_max: 0, sent_stub: 0, unreachable: 0, failed: 0, reach_unknown: 0, failed_kinds: [],
  };
  if (isQuietHour(now)) return { ...report, quiet: true };

  const params = [now.toISOString(), INBOX_REMIND_AFTER_MINUTES, INBOX_REMIND_WINDOW_HOURS];
  const settled = await Promise.allSettled(
    INBOX_REMIND_KINDS.map((k) => db.query<WaitingRow>(INBOX_REMIND_SQL[k], params)),
  );
  const items: Item[] = [];
  settled.forEach((r, i) => {
    const kind = INBOX_REMIND_KINDS[i];
    if (r.status === 'fulfilled') items.push(...r.value.rows.map((row) => ({ ...row, kind })));
    else {
      const code = (r.reason as { code?: string })?.code ?? 'нет SQLSTATE';
      console.error(`[crm-inbox-reminders] ${kind} не прочитан, SQLSTATE`, code);
      report.failed_kinds.push(kind);
    }
  });
  report.due = items.length;

  const byPartner = new Map<string, Item[]>();
  for (const it of items) {
    const list = byPartner.get(it.partner_id);
    if (list) list.push(it);
    else byPartner.set(it.partner_id, [it]);
  }
  report.partners = byPartner.size;

  const mark = (partnerId: string, list: Item[], channel: 'max' | 'telegram_stub' | 'unreachable') =>
    db.query(MARK_INBOX_REMINDED_SQL, [partnerId, list.map((i) => i.kind), list.map((i) => i.item_id), channel]);

  for (const [partnerId, list] of byPartner) {
    // Дольше всех ждёт — первым в сообщении.
    list.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const to = await reach(partnerId);
    if (!to) {
      report.reach_unknown += 1;
      continue;
    }
    if (!to.reachable) {
      await mark(partnerId, list, 'unreachable');
      report.unreachable += 1;
      continue;
    }
    const res = await send({ ...inboxReminderMessage(list), to: { maxChatId: to.maxChatId, telegramChatId: to.telegramChatId } });
    if (res.channel === 'none') {
      console.error('[crm-inbox-reminders] напоминание не доставлено, повтор в следующем прогоне:', res.reason);
      report.failed += 1;
      continue;
    }
    await mark(partnerId, list, CHANNEL_OF[res.channel]);
    if (res.channel === 'max') report.sent_max += 1;
    else report.sent_stub += 1;
  }
  return report;
}
