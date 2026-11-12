/**
 * lib/requests/cancel-request.ts — отмена заявки клиентом (1427).
 *
 * Слово владельца 11.11: заявку можно отменить «как самим человеком», а на
 * вопрос «что будет по нажатию» — «зависит от ответа», как у смены даты:
 *   - адресат ещё не ответил — заявка отменяется сразу (`leads.status =
 *     'cancelled'`), адресату уходит «турист отменил заявку»;
 *   - адресат уже ответил или по заявке есть бронь — отменяет он: ему уходит
 *     просьба, заявка и бронь не трогаются. Бронь здесь не отменяется никогда:
 *     деньги и места — зона оператора (CLAUDE.md §7).
 *
 * «Ответил» — то же выражение, что у смены даты (`ANSWERED_SQL`,
 * lib/requests/my-trip-date), и оно же стоит условием записи: ответ, пришедший
 * между чтением и нажатием, превращает отмену в просьбу, а не затирается.
 * Заявка без адресата (большая группа, переданная другим операторам, или
 * отданная кроном менеджеру) отменяется сразу: «просить» некого, а не
 * отменить — значит дальше раздавать имя и телефон человека, который уже
 * отказался. О такой отмене узнаёт менеджер.
 *
 * «Договорились» и бронь — всегда просьба, и у заявки без адресата тоже: за
 * ней уже кто-то держит места, и закрывает её тот, кто договаривался. Такая
 * просьба уходит менеджеру Ведара.
 *
 * Одна отмена и одна просьба на заявку — уникальными индексами (1427): повтор
 * нажатия и параллельный вызов второго сообщения адресату не дают.
 *
 * Не дошло до адресата — не «ничего страшного»: он может держать места или
 * приехать. Тогда строка без ПД уходит менеджеру Ведара, а клиенту сказано,
 * что оператору сообщить не удалось.
 *
 * Просьба — единственный след того, что человек хотел отменить: заявка и бронь
 * при ней не меняются. Поэтому запись просьбы помнит, КОМУ она дошла, и повтор
 * нажатия отвечает этим, а не «уже отправлена оператору». Не дошла никому —
 * запись уходит в журнал под именем `cancel_request_undelivered` и место
 * единственной освобождает: следующее нажатие отправит заново, а не упрётся в
 * «уже просили». Зависшая без исхода (процесс умер между записью и отправкой)
 * освобождается так же — через две минуты (`CANCEL_REQUEST_PENDING_MINUTES`).
 *
 * Здесь — ядро: чтение заявки, запись, сообщения адресату и менеджеру. Право
 * («чья заявка») проверяет дверь: чат «Моей поездки» (lib/requests/
 * my-trip-cancel) — связью чата с заявкой. ПД нет нигде: тур, дата, число людей.
 */
import { pool } from '@/lib/db-pool';
import { getPublicBaseUrl } from '@/lib/config';
import { logText } from '@/lib/log/log-text';
import { escapeHtml } from '@/lib/text/escape-html';
import { recordSourceEventQuietly, statusChangeTitle } from '@/lib/crm/events';
import { ANSWERED_SQL } from '@/lib/requests/my-trip-date';
import { MY_TRIP_CLOSED_BOOKING } from '@/lib/requests/my-trip-ask';
import { notifyRequestOperator, operatorTold, type OperatorNotice } from '@/lib/requests/notify-request-operator';
import { LEAD_CLIENT_CANCELLED } from '@/lib/types/statuses';
import type { LinkChannel } from '@/lib/requests/chat-links';

/** Откуда пришла отмена — в журнал заявки: чат человека или ИИ-агент по ключу заявки (change_request). */
export type CancelChannel = LinkChannel | 'mcp' | 'a2a';

/** Отмену передал не сам человек в чате, а его ИИ-агент: адресату и менеджеру это названо. */
const viaAgent = (channel: CancelChannel): boolean => channel === 'mcp' || channel === 'a2a';

export interface CancelLeadRow {
  id: string;
  status: string | null;
  /** Адресат заявки; null — большая группа передана другим или заявка у менеджера. */
  operator_id: string | null;
  date: string | null;
  participants: number | null;
  tour_title: string | null;
  booking_status: string | null;
  booking_date: string | null;
  answered: boolean;
  /** Действующая просьба об отмене и её доставка; null — просьбы нет. */
  cancel_request: CancelRequestMark | null;
}

/** Что записано о действующей просьбе: кому дошла и свежа ли запись. */
export interface CancelRequestMark {
  /** Исход сообщения адресату (`max`, `telegram`, `none`, `unknown`, `no_addressee`); null — ещё не записан. */
  delivery: string | null;
  /** Исход строки менеджеру (`told`, `failed`, `not_needed`); null — ещё не записан. */
  manager: string | null;
  /** Запись моложе `CANCEL_REQUEST_PENDING_MINUTES`: отправка ещё может идти. */
  fresh: boolean;
}

/** Сколько минут запись просьбы без исхода считается «ещё отправляется». */
export const CANCEL_REQUEST_PENDING_MINUTES = 2;
/**
 * Тот же срок интервалом SQL: единица — литералом, число — множителем. Число
 * внутрь литерала (`INTERVAL '2 minutes'` склейкой) не подставляется — это
 * форма, которую запрещает сторож sql-interval-not-concatenated.
 */
const CANCEL_REQUEST_PENDING_SQL = `(INTERVAL '1 minute' * ${CANCEL_REQUEST_PENDING_MINUTES})`;

/** Колонки заявки для отмены — одни на каждую дверь; псевдоним лида — `l`. */
export const CANCEL_LEAD_COLUMNS_SQL = `
  l.id::text AS id, l.status, l.operator_id::text AS operator_id,
  l.source_data->>'date' AS date,
  CASE WHEN l.source_data->>'participants' ~ '^[0-9]{1,3}$' THEN (l.source_data->>'participants')::int END AS participants,
  ot.title AS tour_title,
  bk.booking_status, bk.booking_date::text AS booking_date,
  ${ANSWERED_SQL} AS answered,
  (SELECT jsonb_build_object(
            'delivery', g_c.details->>'delivery',
            'manager', g_c.details->>'manager',
            'fresh', g_c.created_at > NOW() - ${CANCEL_REQUEST_PENDING_SQL})
     FROM lead_activity_log g_c
    WHERE g_c.lead_id = l.id AND g_c.action = 'cancel_requested') AS cancel_request`;

export const CANCEL_LEAD_JOINS_SQL = `
  LEFT JOIN operator_tours ot
         ON ot.id = CASE WHEN l.source_data->>'tour_id' ~ '^[0-9]{1,18}$' THEN (l.source_data->>'tour_id')::bigint END
  LEFT JOIN LATERAL (
    SELECT b.booking_status, b.booking_date FROM operator_bookings b
     WHERE b.lead_id = l.id AND b.deleted_at IS NULL
     ORDER BY b.created_at DESC
     LIMIT 1
  ) bk ON TRUE`;

/**
 * Отмена сразу — одним оператором: статус, только пока адресат не ответил и
 * брони нет, и запись журнала. `$1` — лид, `$2` — канал. Нет строки — адресат
 * успел ответить, заявку уже отменили или она закрыта: вызывающий перечитывает.
 * Прежний статус и адресат берутся под блокировкой строки — ими же пишется
 * журнал и решается, кому сообщать.
 */
export const CANCEL_NOW_SQL = `
  WITH prev AS (
    SELECT l.id, l.status, l.operator_id FROM leads l WHERE l.id = $1::uuid FOR UPDATE
  ), u AS (
    UPDATE leads l
       SET status = '${LEAD_CLIENT_CANCELLED}', updated_at = NOW()
      FROM prev
     WHERE l.id = prev.id
       AND l.status NOT IN ('${LEAD_CLIENT_CANCELLED}', 'lost', 'converted')
       AND NOT EXISTS (SELECT 1 FROM operator_bookings ob_c WHERE ob_c.lead_id = l.id AND ob_c.deleted_at IS NULL)
       AND (l.operator_id IS NULL OR NOT ${ANSWERED_SQL})
    RETURNING l.id, prev.status AS prev_status, prev.operator_id
  )
  INSERT INTO lead_activity_log (lead_id, actor, action, details)
  SELECT u.id, 'tourist', 'client_cancelled', jsonb_build_object('channel', $2::text, 'from', u.prev_status)
    FROM u
  RETURNING id::text AS log_id,
            (SELECT prev_status FROM u) AS prev_status,
            (SELECT operator_id::text FROM u) AS operator_id`;

/**
 * Просьба адресату отменить — запись журнала, одна на заявку (индекс 1427).
 * Нет строки — просьба уже была либо заявку за это время закрыли.
 */
export const CANCEL_REQUEST_SQL = `
  INSERT INTO lead_activity_log (lead_id, actor, action, details)
  SELECT l.id, 'tourist', 'cancel_requested', jsonb_build_object('channel', $2::text)
    FROM leads l
   WHERE l.id = $1::uuid AND l.status NOT IN ('${LEAD_CLIENT_CANCELLED}', 'lost')
  ON CONFLICT DO NOTHING
  RETURNING id::text AS log_id`;

/** Чем кончились сообщения адресату и менеджеру — в ту же запись журнала. */
export const CANCEL_DELIVERY_SQL = `
  UPDATE lead_activity_log
     SET details = details || jsonb_build_object('delivery', $2::text, 'manager', $3::text)
   WHERE id = $1::bigint`;

/**
 * Просьба не дошла никому: запись остаётся в журнале с исходом, но под другим
 * именем — место единственной просьбы (индекс 1427) свободно, и следующее
 * нажатие отправит заново.
 */
export const CANCEL_REQUEST_UNDELIVERED_SQL = `
  UPDATE lead_activity_log
     SET action = 'cancel_request_undelivered',
         details = details || jsonb_build_object('delivery', $2::text, 'manager', $3::text)
   WHERE id = $1::bigint`;

/**
 * Зависшая просьба: исхода «дошла» нет, а запись старше срока — процесс умер
 * между записью и отправкой либо исход не записался. `$1` — лид. Дошедшую
 * оператору или менеджеру не трогает.
 */
export const CANCEL_REQUEST_RELEASE_SQL = `
  UPDATE lead_activity_log
     SET action = 'cancel_request_undelivered'
   WHERE lead_id = $1::uuid AND action = 'cancel_requested'
     AND COALESCE(details->>'delivery', '') NOT IN ('max', 'telegram')
     AND COALESCE(details->>'manager', '') <> 'told'
     AND created_at <= NOW() - ${CANCEL_REQUEST_PENDING_SQL}`;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function ruDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

function logFail(what: string, err: unknown): void {
  const code = (err as { code?: unknown })?.code;
  console.error(
    `[cancel-request] ${what}:`,
    typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : 'SQLSTATE=нет',
    logText(err instanceof Error ? err.message : err, 160),
  );
}

/** Почему отменять нечего: уже отменена, закрыта (отказ, состоявшаяся или отменённая бронь) или поездка прошла. */
export type CancelBlock = 'cancelled' | 'closed' | 'past';

export function cancelBlock(
  lead: Pick<CancelLeadRow, 'status' | 'booking_status' | 'booking_date' | 'date'>, today: string,
): CancelBlock | null {
  if (lead.status === LEAD_CLIENT_CANCELLED) return 'cancelled';
  if (lead.status === 'lost' || (lead.booking_status !== null && MY_TRIP_CLOSED_BOOKING.has(lead.booking_status))) return 'closed';
  const date = lead.booking_date ?? lead.date;
  // Дата не записана — не повод держать заявку: отменить можно. Прошедшую поездку отменять поздно.
  if (date && ISO_DAY.test(date) && date < today) return 'past';
  return null;
}

/**
 * Что сделает нажатие: отмена сразу или просьба. Бронь и «Договорились» —
 * всегда просьба (и без адресата: тогда она уходит менеджеру); иначе без
 * адресата — сразу (просить некого), с адресатом — по его ответу.
 */
export function cancelMode(lead: Pick<CancelLeadRow, 'status' | 'operator_id' | 'booking_status' | 'answered'>): 'now' | 'request' {
  if (lead.booking_status !== null || lead.status === 'converted') return 'request';
  return lead.operator_id !== null && lead.answered ? 'request' : 'now';
}

/**
 * Что известно о прежней просьбе: дошла оператору, дошла только менеджеру,
 * ещё отправляется (запись свежая, исхода нет) или зависла без доставки.
 */
export type PriorCancelRequest = 'none' | 'operator' | 'manager' | 'pending' | 'stale';

export function priorCancelRequest(lead: Pick<CancelLeadRow, 'cancel_request'>): PriorCancelRequest {
  const r = lead.cancel_request;
  if (!r) return 'none';
  if (r.delivery === 'max' || r.delivery === 'telegram') return 'operator';
  if (r.manager === 'told') return 'manager';
  return r.fresh ? 'pending' : 'stale';
}

interface CancelFacts { title: string; date: string | null; people: number | null }

function factsLine(f: CancelFacts): string {
  return [
    `Тур «${escapeHtml(f.title)}»`,
    f.date && ISO_DAY.test(f.date) ? ruDate(f.date) : null,
    f.people && f.people > 0 ? `участников ${f.people}` : null,
  ].filter(Boolean).join(', ');
}

const factsOf = (lead: CancelLeadRow): CancelFacts => ({
  title: lead.tour_title ?? 'тур заявки',
  date: lead.booking_date ?? lead.date,
  people: lead.participants,
});

/**
 * Адресату без ПД: что отменено или о чём просят. Сообщение самодостаточно —
 * тур, дата, люди. `agent` — отмену передал ИИ-агент по ключу заявки: «отменил
 * сам турист в чате» о таком вызове было бы неправдой.
 */
export function operatorCancelText(kind: 'cancelled' | 'request', f: CancelFacts, agent = false): string {
  return kind === 'cancelled'
    ? [
      '<b>Турист отменил заявку</b>',
      `${factsLine(f)}.`,
      `${agent ? 'Отмену передал ИИ-агент туриста по ключу заявки' : 'Отменил сам турист в чате Ведара'}, пока вы не ответили. Заявка закрыта: отвечать по ней и держать места не нужно.`,
    ].join('\n')
    : [
      '<b>Турист просит отменить заявку</b>',
      `${factsLine(f)}.`,
      ...(agent ? ['Просьбу передал ИИ-агент туриста по ключу заявки.'] : []),
      'Вы уже ответили по заявке, поэтому закрываете её вы — и бронь, если она заведена: Ведар ничего не менял. Туристу ответьте в переписке по заявке или звонком.',
    ].join('\n');
}

/** Менеджеру без ПД: адресат об отмене или просьбе не узнал — или адресата у заявки нет. */
export function managerCancelText(
  kind: 'cancelled' | 'request', leadId: string, f: CancelFacts, why: 'no_addressee' | 'not_told', agent = false,
): string {
  const what = kind === 'cancelled' ? 'Клиент отменил заявку' : 'Клиент просит отменить заявку';
  const tail = why === 'no_addressee'
    ? kind === 'cancelled'
      ? 'У заявки нет адресата (передана другим операторам или была у вас): дальше её никому не передаём. Если кто-то из операторов уже взялся — предупредите его.'
      : 'У заявки нет адресата, но по ней записана бронь или отметка «Договорились»: заявка и бронь действуют. Закройте их сами или передайте просьбу тому, кто договаривался.'
    : kind === 'cancelled'
      ? 'Оператору сообщить не удалось — сообщите ему: он может держать места.'
      : 'Оператору сообщить не удалось — передайте ему просьбу: заявка (и бронь, если она заведена) пока действует.';
  return [
    `<b>${what}</b>`,
    `Заявка <code>${escapeHtml(leadId)}</code>: ${factsLine(f)}.`,
    ...(agent ? ['Передал ИИ-агент клиента по ключу заявки.'] : []),
    tail,
  ].join('\n');
}

/** Строка менеджеру: ушла / не ушла / не требовалась (адресат узнал сам). */
export type ManagerNotice = 'told' | 'failed' | 'not_needed';

async function tellManager(
  kind: 'cancelled' | 'request', leadId: string, f: CancelFacts, why: 'no_addressee' | 'not_told', agent: boolean,
): Promise<Exclude<ManagerNotice, 'not_needed'>> {
  try {
    const { sendPdAlert } = await import('@/lib/notifications/pd-alert');
    const text = managerCancelText(kind, leadId, f, why, agent);
    // ПД в тексте нет — он один на MAX и на заглушку в Telegram.
    const res = await sendPdAlert({
      text, stub: text,
      buttons: [{ text: 'Заявка в админке', url: `${getPublicBaseUrl()}/hub/admin/leads` }],
    });
    const ok = res.delivered || res.channel === 'telegram-stub';
    if (!ok) console.error(`[cancel-request] менеджеру об отмене по заявке ${leadId} не доставлено (${res.channel}) — ${logText(res.reason, 160)}`);
    return ok ? 'told' : 'failed';
  } catch (err) {
    logFail(`менеджеру об отмене по заявке ${leadId} не отправлено`, err);
    return 'failed';
  }
}

export type CancelOutcome =
  /** Отменена сразу. `told` — узнал ли адресат; `manager` — строка менеджеру, когда адресата нет или он не узнал. */
  | { kind: 'cancelled'; told: OperatorNotice | 'no_addressee'; manager: ManagerNotice }
  /**
   * Адресат уже ответил, есть бронь или «Договорились»: просьба дошла — адресату
   * либо (он не узнал или его нет) менеджеру. Заявка не тронута.
   */
  | { kind: 'requested'; told: OperatorNotice | 'no_addressee'; manager: 'told' | 'not_needed' }
  /** Просьба не дошла никому: заявка в силе, нажать можно снова. */
  | { kind: 'request_undelivered'; addressee: boolean }
  | { kind: 'already_cancelled' }
  /** Просьба уже есть: дошла оператору, только менеджеру или ещё отправляется. */
  | { kind: 'already_requested'; via: 'operator' | 'manager' | 'pending' }
  | { kind: 'closed' }
  | { kind: 'past' }
  /** Сбой базы: ничего не изменено. */
  | { kind: 'failed' };

/**
 * Отменить заявку или попросить об отмене. `lead` — уже прочитанная дверью
 * заявка (право проверено там); `reread` — её же чтение ещё раз: если запись
 * не прошла, правду о заявке надо узнать заново, а не угадать.
 */
export async function cancelLeadByClient(args: {
  lead: CancelLeadRow;
  channel: CancelChannel;
  today: string;
  reread: () => Promise<CancelLeadRow | null | 'failed'>;
}): Promise<CancelOutcome> {
  let lead = args.lead;
  const agent = viaAgent(args.channel);
  // Вторая попытка — после перечитывания: адресат мог ответить между чтением и записью.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const block = cancelBlock(lead, args.today);
    if (block === 'cancelled') return { kind: 'already_cancelled' };
    if (block) return { kind: block };
    const facts = factsOf(lead);

    if (cancelMode(lead) === 'now') {
      let row: { log_id: string; prev_status: string | null; operator_id: string | null } | undefined;
      try {
        ({ rows: [row] } = await pool.query<{ log_id: string; prev_status: string | null; operator_id: string | null }>(
          CANCEL_NOW_SQL, [lead.id, args.channel],
        ));
      } catch (err) {
        logFail('отмена заявки не записана', err);
        return { kind: 'failed' };
      }
      if (row) {
        await recordSourceEventQuietly({
          kind: 'status_change', sourceKind: 'lead', sourceId: lead.id, actorKind: 'tourist',
          title: statusChangeTitle('lead', row.prev_status, LEAD_CLIENT_CANCELLED),
          payload: { from: row.prev_status, to: LEAD_CLIENT_CANCELLED, via: args.channel },
        });
        const told: OperatorNotice | 'no_addressee' = row.operator_id === null
          ? 'no_addressee'
          : await notifyRequestOperator({
            operatorId: row.operator_id, leadId: lead.id,
            text: () => operatorCancelText('cancelled', facts, agent),
            log: { tag: 'cancel-request', about: 'об отмене' },
          });
        const manager: ManagerNotice = told === 'no_addressee' || !operatorTold(told)
          ? await tellManager('cancelled', lead.id, facts, told === 'no_addressee' ? 'no_addressee' : 'not_told', agent)
          : 'not_needed';
        await recordDelivery(row.log_id, told, manager);
        return { kind: 'cancelled', told, manager };
      }
    } else {
      const prior = priorCancelRequest(lead);
      if (prior === 'operator' || prior === 'manager' || prior === 'pending') return { kind: 'already_requested', via: prior };
      let logId: string | undefined;
      try {
        // Зависшая без исхода просьба место освобождает — иначе новая упрётся в единственность.
        if (prior === 'stale') await pool.query(CANCEL_REQUEST_RELEASE_SQL, [lead.id]);
        const { rows: [row] } = await pool.query<{ log_id: string }>(CANCEL_REQUEST_SQL, [lead.id, args.channel]);
        logId = row?.log_id;
      } catch (err) {
        logFail('просьба об отмене не записана', err);
        return { kind: 'failed' };
      }
      if (logId) {
        const told: OperatorNotice | 'no_addressee' = lead.operator_id === null
          ? 'no_addressee'
          : await notifyRequestOperator({
            operatorId: lead.operator_id, leadId: lead.id,
            text: () => operatorCancelText('request', facts, agent),
            log: { tag: 'cancel-request', about: 'о просьбе отменить' },
          });
        const manager: ManagerNotice = told !== 'no_addressee' && operatorTold(told)
          ? 'not_needed'
          : await tellManager('request', lead.id, facts, told === 'no_addressee' ? 'no_addressee' : 'not_told', agent);
        if (manager === 'failed') {
          // Не узнал никто: просьбы как бы не было — так и записано, и человеку сказано это.
          await recordDelivery(logId, told, manager, CANCEL_REQUEST_UNDELIVERED_SQL);
          return { kind: 'request_undelivered', addressee: told !== 'no_addressee' };
        }
        await recordDelivery(logId, told, manager);
        return { kind: 'requested', told, manager };
      }
    }

    // Запись не прошла: заявка изменилась между чтением и нажатием. Перечитываем,
    // чтобы ответить правдой («уже отменена», «оператор ответил», «закрыта»).
    const again = await args.reread();
    if (again === 'failed' || again === null) return { kind: 'failed' };
    lead = again;
  }
  // Два круга подряд запись не прошла — состояние заявки меняется быстрее, чем читается.
  console.error(`[cancel-request] заявка ${lead.id}: отмена не записана за две попытки`);
  return { kind: 'failed' };
}

async function recordDelivery(
  logId: string, told: OperatorNotice | 'no_addressee', manager: ManagerNotice, sql: string = CANCEL_DELIVERY_SQL,
): Promise<void> {
  try {
    await pool.query(sql, [logId, told, manager]);
  } catch (err) {
    logFail('исход сообщения об отмене не записан', err);
  }
}
