/**
 * lib/manager-queue/queue.ts — очередь менеджера (план «после отказа», этап 3б;
 * слово владельца 11.11 «карт-бланш по плану действуй»).
 *
 * Случаи, где человеку после отказа нужен звонок или замена, одним списком:
 *  - `answer_notice`   — туроператор или гид отказал, а сообщение до человека
 *    не дошло: ни чат, ни ИИ-агент его не приняли. Позвонить и сказать;
 *  - `vehicle_decline` — перевозчик или прокатчик ответил «Не могу»: заказчику
 *    нужен другой. Дошло ли сообщение об отказе — сказано в строке;
 *  - `stay_busy`       — хозяин жилья ответил «занято»: гостю нужно другое жильё.
 * До этого среза такие случаи приходили менеджеру тремя сообщениями в два
 * мессенджера и нигде не лежали списком; отметки «взял» не было.
 *
 * Очередь не хранится — её собирают три запроса из уже записанного. Источники
 * читаются независимо: отказ одного не прячет остальные и не выдаётся за
 * «никого нет» (§4.0). Хранится только отметка «взял» (manager_queue_takes,
 * миграция 1430): одна на случай, второй менеджер видит, кто взял.
 *
 * Случай выходит из очереди сам, когда перестаёт быть правдой:
 *  - сообщение дошло (строка answer_notices больше не «не доставлено»);
 *  - заявка переросла отказ: бронь, новая дата, возврат в работу, другой
 *    статус. Сверяется тем же правилом, что решает, слать ли письмо менеджеру
 *    (viewHolds, lib/requests/answer-notice): вид заявки построен из этого
 *    отказа — случай в очереди, уже нет — звонить с ним некому и незачем.
 *    У жилья такого правила нет: ответ хозяина один и не меняется.
 * «Взял» — не «сделано»: отметка говорит только, что случаем занимается человек.
 *
 * ПД: имя и телефон клиента отдаются только администратору на сайте
 * (requireAdmin у двери). В лог — имя источника и SQLSTATE, без строк.
 */
import { pool } from '@/lib/db-pool';
import { REQUEST_STATUS_BY_LEADS_SQL, type StatusRow } from '@/lib/mcp/request-status';
import { viewHolds, type NoticeAnswerRef } from '@/lib/requests/answer-notice';
import {
  isQueueSubjectId,
  type ManagerQueue, type NoticeItem, type QueueBase, type QueueKind, type QueueSource, type QueueTake, type StayItem, type VehicleItem,
} from '@/lib/manager-queue/types';

export { QUEUE_KINDS, isQueueSubjectId } from '@/lib/manager-queue/types';
export type {
  ManagerQueue, NoticeItem, QueueItem, QueueKind, QueueSource, QueueTake, StayItem, VehicleItem,
} from '@/lib/manager-queue/types';

/**
 * С какого дня ведётся очередь — день выката среза. Более ранние отказы в неё
 * не попадают: по ним «взял» никто не ставил, и список из прошлого выглядел бы
 * как невыполненная работа, которой не было. Они по-прежнему в «Заявках».
 */
export const MANAGER_QUEUE_SINCE = '2026-11-12';
/** Сколько последних случаев одного рода очередь разбирает; больше — сказано, что более ранние не разобраны. */
export const QUEUE_SOURCE_LIMIT = 200;
/** Сколько дней взятый случай остаётся на виду. */
export const QUEUE_TAKEN_DAYS = 7;

const takeJoin = (kind: QueueKind, idExpr: string) => `
    LEFT JOIN manager_queue_takes t ON t.subject_kind = '${kind}' AND t.subject_id = ${idExpr}
    LEFT JOIN users tu ON tu.id = t.taken_by`;
const TAKE_COLS = `t.taken_at, t.via AS taken_via, tu.name AS taken_by_name, (t.subject_id IS NOT NULL) AS is_taken`;
/** Взятый случай виден ещё QUEUE_TAKEN_DAYS дней ($2 — число дней, параметром); невзятый — пока он правда. */
const TAKEN_WINDOW = `(t.subject_id IS NULL OR t.taken_at > NOW() - INTERVAL '1 day' * $2::int)`;

/**
 * Условие «случай стоит в очереди» по самим строкам — одно на список и на
 * отметку «взял». Вторая половина правила — сверка с видом заявки (holding).
 */
const NOTICE_IN_QUEUE = `n.state = 'undelivered' AND (n.activity_id IS NULL OR al.action = 'seller_closed') AND l.is_self = FALSE`;
const VEHICLE_IN_QUEUE = `al.action = 'partner_answered' AND al.details->>'answer' = 'decline' AND l.is_self = FALSE`;
const STAY_IN_QUEUE = `s.owner_answer = 'busy'`;

/**
 * Отказ туроператора или гида, не дошедший до человека. «Не могу» перевозчика
 * и прокатчика сюда не входит: у него своя строка (vehicle_decline), и там же
 * сказано, дошло ли сообщение, — иначе случай после доставки «переезжал» бы из
 * одного рода в другой и терял отметку.
 */
export const QUEUE_NOTICES_SQL = `
  SELECT n.id::text AS id, COALESCE(n.decided_at, n.created_at) AS happened_at,
         n.answer, n.decline_reason, n.manager_channel,
         n.answer_id::text AS answer_id, n.activity_id::text AS activity_id, al.action AS activity_action,
         l.id::text AS lead_id, l.name AS contact_name, l.phone AS contact_phone, l.status AS lead_status,
         l.route_title, l.source_data->>'date' AS req_date, l.source_data->>'participants' AS people,
         p.name AS partner_name, ${TAKE_COLS}
    FROM answer_notices n
    JOIN leads l ON l.id = n.lead_id
    LEFT JOIN lead_activity_log al ON al.id = n.activity_id
    LEFT JOIN partner_incoming_answers pa ON pa.id = n.answer_id
    LEFT JOIN partners p ON p.id = COALESCE(pa.partner_id, l.operator_id)${takeJoin('answer_notice', 'n.id::text')}
   WHERE ${NOTICE_IN_QUEUE}
     AND n.created_at >= $1::date AND ${TAKEN_WINDOW}
   ORDER BY COALESCE(n.decided_at, n.created_at) DESC
   LIMIT ${QUEUE_SOURCE_LIMIT + 1}`;

/**
 * Когда партнёр ответил: `details.at` — время из приложения (у `created_at`
 * журнала тип без зоны, lib/rental/request-answer-store); нет его — время
 * строки, прочитанное в зоне базы.
 */
const VEHICLE_AT = `COALESCE(
           CASE WHEN al.details->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}' THEN (al.details->>'at')::timestamptz END,
           al.created_at::timestamptz)`;

/** «Не могу» перевозчика или прокатчика; `notice_state` — что стало с сообщением заказчику. */
export const QUEUE_VEHICLE_SQL = `
  SELECT al.id::text AS id, ${VEHICLE_AT} AS happened_at,
         COALESCE(al.details->>'kind', 'car_rental') AS vehicle_kind, al.details->>'car_title' AS vehicle_title,
         al.details->>'date_from' AS date_from, al.details->>'date_to' AS date_to,
         l.id::text AS lead_id, l.name AS contact_name, l.phone AS contact_phone, l.status AS lead_status,
         p.name AS partner_name, n.state AS notice_state, ${TAKE_COLS}
    FROM lead_activity_log al
    JOIN leads l ON l.id = al.lead_id
    LEFT JOIN partners p ON p.id = l.operator_id
    LEFT JOIN answer_notices n ON n.activity_id = al.id${takeJoin('vehicle_decline', 'al.id::text')}
   WHERE ${VEHICLE_IN_QUEUE}
     AND al.created_at >= $1::date AND ${TAKEN_WINDOW}
   ORDER BY al.created_at DESC
   LIMIT ${QUEUE_SOURCE_LIMIT + 1}`;

/** «Занято» хозяина жилья. */
export const QUEUE_STAY_SQL = `
  SELECT s.id::text AS id, s.owner_answered_at AS happened_at, a.name AS accommodation_name,
         s.check_in_date::text AS check_in, s.check_out_date::text AS check_out, s.guests::int AS guests,
         s.guest_name AS contact_name, s.guest_phone AS contact_phone, p.name AS partner_name, ${TAKE_COLS}
    FROM stay_requests s
    JOIN accommodations a ON a.id = s.accommodation_id
    LEFT JOIN partners p ON p.id = a.partner_id${takeJoin('stay_busy', 's.id::text')}
   WHERE ${STAY_IN_QUEUE}
     AND s.owner_answered_at >= $1::date AND ${TAKEN_WINDOW}
   ORDER BY s.owner_answered_at DESC
   LIMIT ${QUEUE_SOURCE_LIMIT + 1}`;

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown): string | null => (typeof v === 'string' && DATE_RE.test(v) ? v : null);
function count(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,4}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function takeOf(r: Row): QueueTake | null {
  if (r.is_taken !== true) return null;
  return { at: iso(r.taken_at), via: str(r.taken_via) ?? 'site', by: str(r.taken_by_name) };
}
const baseOf = (r: Row): QueueBase => ({
  id: String(r.id), happened_at: iso(r.happened_at), partner_name: str(r.partner_name),
  contact_name: str(r.contact_name), contact_phone: str(r.contact_phone), take: takeOf(r),
});

const NOTICE_STATES = ['pending', 'delivered', 'undelivered', 'skipped'] as const;

const toNotice = (r: Row): NoticeItem => ({
  ...baseOf(r), kind: 'answer_notice', lead_id: String(r.lead_id), lead_status: str(r.lead_status),
  answer: String(r.answer), decline_reason: str(r.decline_reason), manager_channel: str(r.manager_channel),
  tour_title: str(r.route_title), date: day(r.req_date), people: count(r.people),
});
const toVehicle = (r: Row): VehicleItem => ({
  ...baseOf(r), kind: 'vehicle_decline', lead_id: String(r.lead_id), lead_status: str(r.lead_status),
  vehicle_kind: r.vehicle_kind === 'charter' ? 'charter' : 'car_rental', vehicle_title: str(r.vehicle_title),
  date_from: day(r.date_from), date_to: day(r.date_to),
  notice_state: (NOTICE_STATES as readonly string[]).includes(String(r.notice_state))
    ? r.notice_state as VehicleItem['notice_state'] : null,
});
const toStay = (r: Row): StayItem => ({
  ...baseOf(r), kind: 'stay_busy', stay_request_id: String(r.id), accommodation_name: String(r.accommodation_name ?? ''),
  check_in: String(r.check_in), check_out: String(r.check_out), guests: Number(r.guests ?? 0),
});

type Query = (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;

/** На какой ответ ссылается случай — в форме строки сообщения (answer_notices). */
const noticeRef = (r: Row): NoticeAnswerRef => ({
  answer_id: str(r.answer_id), activity_id: str(r.activity_id), activity_action: str(r.activity_action),
});
/** «Не могу» перевозчика или прокатчика — сама запись журнала. */
const vehicleRef = (r: Row): NoticeAnswerRef => ({
  answer_id: null, activity_id: String(r.id), activity_action: 'partner_answered',
});

/**
 * Какие из случаев всё ещё правда: вид заявки построен из этого отказа. Один
 * запрос на список. Бросает при отказе базы — источник тогда «не прочитался»:
 * список, в котором могут стоять перекрытые бронью отказы, хуже отсутствующего.
 */
async function holding(q: Query, subjects: Array<{ leadId: string; ref: NoticeAnswerRef }>): Promise<boolean[]> {
  if (subjects.length === 0) return [];
  const leads = [...new Set(subjects.map((s) => s.leadId))];
  const { rows } = await q(REQUEST_STATUS_BY_LEADS_SQL, [leads]);
  const byLead = new Map((rows as StatusRow[]).map((r) => [String(r.lead_id), r]));
  return subjects.map((s) => viewHolds(byLead.get(s.leadId), s.ref));
}

async function readSource<T>(
  q: Query, since: string, name: string, sql: string, map: (r: Row) => T, refOf: ((r: Row) => NoticeAnswerRef) | null,
): Promise<QueueSource<T>> {
  try {
    const { rows } = await q(sql, [since, QUEUE_TAKEN_DAYS]);
    const page = (rows as Row[]).slice(0, QUEUE_SOURCE_LIMIT);
    const holds = refOf ? await holding(q, page.map((r) => ({ leadId: String(r.lead_id), ref: refOf(r) }))) : null;
    const items = page.filter((_, i) => holds === null || holds[i] === true).map(map);
    return { state: 'ok', items, more: rows.length > QUEUE_SOURCE_LIMIT };
  } catch (err) {
    console.error(`[manager-queue] источник «${name}» не прочитан, SQLSTATE`, (err as { code?: string } | null)?.code ?? 'нет');
    return { state: 'failed' };
  }
}

/** `since` — только для проверок: день начала очереди в работе один, MANAGER_QUEUE_SINCE. */
export interface QueueDeps { query?: Query; since?: string }

export async function loadManagerQueue(deps: QueueDeps = {}): Promise<ManagerQueue> {
  const q: Query = deps.query ?? ((sql, params) => pool.query(sql, params));
  const since = deps.since ?? MANAGER_QUEUE_SINCE;
  const [answer_notice, vehicle_decline, stay_busy] = await Promise.all([
    readSource(q, since, 'недоставленные отказы', QUEUE_NOTICES_SQL, toNotice, noticeRef),
    readSource(q, since, '«Не могу» перевозчика и прокатчика', QUEUE_VEHICLE_SQL, toVehicle, vehicleRef),
    readSource(q, since, '«Занято» жилья', QUEUE_STAY_SQL, toStay, null),
  ]);
  return { since, answer_notice, vehicle_decline, stay_busy };
}

/**
 * Отметка ставится, только пока случай стоит в очереди: тем же условием, что
 * его показывает, и не раньше дня начала очереди. Номер сравнивается текстом —
 * чужая форма даёт «не найден», а не ошибку приведения. `id` и `since` — номера
 * параметров: запрос записи и чтение случая ставят их на разные места.
 */
const subjectFrom = (kind: QueueKind, id: string, since: string): string => ({
  answer_notice: `FROM answer_notices n
                    JOIN leads l ON l.id = n.lead_id
                    LEFT JOIN lead_activity_log al ON al.id = n.activity_id
                   WHERE n.id::text = ${id}::text AND ${NOTICE_IN_QUEUE} AND n.created_at >= ${since}::date`,
  vehicle_decline: `FROM lead_activity_log al
                      JOIN leads l ON l.id = al.lead_id
                     WHERE al.id::text = ${id}::text AND ${VEHICLE_IN_QUEUE} AND al.created_at >= ${since}::date`,
  stay_busy: `FROM stay_requests s
               WHERE s.id::text = ${id}::text AND ${STAY_IN_QUEUE} AND s.owner_answered_at >= ${since}::date`,
}[kind]);

export const queueTakeSql = (kind: QueueKind): string => `
  INSERT INTO manager_queue_takes (subject_kind, subject_id, taken_by, via)
  SELECT $1::text, $2::text, $3::uuid, $4::text
   WHERE EXISTS (SELECT 1 ${subjectFrom(kind, '$2', '$5')})
  ON CONFLICT (subject_kind, subject_id) DO NOTHING
  RETURNING taken_at`;

/** Заявка случая и ответ, на который он ссылается, — для сверки с видом заявки перед отметкой. */
export const QUEUE_SUBJECT_SQL: Record<Exclude<QueueKind, 'stay_busy'>, string> = {
  answer_notice: `SELECT n.lead_id::text AS lead_id, n.answer_id::text AS answer_id,
                         n.activity_id::text AS activity_id, al.action AS activity_action
                    ${subjectFrom('answer_notice', '$1', '$2')}`,
  vehicle_decline: `SELECT al.lead_id::text AS lead_id, al.id::text AS id
                      ${subjectFrom('vehicle_decline', '$1', '$2')}`,
};

export const QUEUE_TAKE_READ_SQL = `
  SELECT t.taken_at, t.via, tu.name AS by_name, (t.taken_by = $3::uuid) AS mine
    FROM manager_queue_takes t
    LEFT JOIN users tu ON tu.id = t.taken_by
   WHERE t.subject_kind = $1::text AND t.subject_id = $2::text`;

export const QUEUE_RELEASE_SQL = `
  DELETE FROM manager_queue_takes WHERE subject_kind = $1::text AND subject_id = $2::text RETURNING taken_at`;

export type TakeOutcome =
  /** Отметка поставлена этим нажатием. */
  | { kind: 'taken'; at: string }
  /** Случай уже взят — этим же человеком или другим. */
  | { kind: 'already'; at: string; by: string | null; mine: boolean }
  /** Такого случая в очереди нет: сообщение дошло, заявка переросла отказ, номер чужой или случай старше очереди. */
  | { kind: 'not_in_queue' }
  | { kind: 'failed' };

export async function takeQueueItem(
  args: { kind: QueueKind; id: string; userId: string; via: 'site' | 'max' }, deps: QueueDeps = {},
): Promise<TakeOutcome> {
  if (!isQueueSubjectId(args.kind, args.id)) return { kind: 'not_in_queue' };
  const q: Query = deps.query ?? ((sql, params) => pool.query(sql, params));
  const since = deps.since ?? MANAGER_QUEUE_SINCE;
  try {
    // Заявка переросла отказ (бронь, новая дата, возврат в работу) — случая в очереди уже нет,
    // и отметка «взял» на нём означала бы звонок с устаревшим отказом.
    if (args.kind !== 'stay_busy') {
      const subject = ((await q(QUEUE_SUBJECT_SQL[args.kind], [args.id, since])).rows as Row[])[0];
      if (!subject) return { kind: 'not_in_queue' };
      const ref = args.kind === 'answer_notice' ? noticeRef(subject) : vehicleRef(subject);
      const [holds] = await holding(q, [{ leadId: String(subject.lead_id), ref }]);
      if (holds !== true) return { kind: 'not_in_queue' };
    }
    const ins = await q(queueTakeSql(args.kind), [args.kind, args.id, args.userId, args.via, since]);
    const taken = (ins.rows as Row[])[0];
    if (taken) return { kind: 'taken', at: iso(taken.taken_at) };
    const prior = ((await q(QUEUE_TAKE_READ_SQL, [args.kind, args.id, args.userId])).rows as Row[])[0];
    if (prior) return { kind: 'already', at: iso(prior.taken_at), by: str(prior.by_name), mine: prior.mine === true };
    return { kind: 'not_in_queue' };
  } catch (err) {
    console.error('[manager-queue] отметка «взял» не записана, SQLSTATE', (err as { code?: string } | null)?.code ?? 'нет');
    return { kind: 'failed' };
  }
}

export type ReleaseOutcome = { kind: 'released' } | { kind: 'not_taken' } | { kind: 'failed' };

/** «Вернуть в очередь»: отметка снята — случай снова ждёт. */
export async function releaseQueueItem(
  args: { kind: QueueKind; id: string }, deps: QueueDeps = {},
): Promise<ReleaseOutcome> {
  if (!isQueueSubjectId(args.kind, args.id)) return { kind: 'not_taken' };
  const q: Query = deps.query ?? ((sql, params) => pool.query(sql, params));
  try {
    const del = await q(QUEUE_RELEASE_SQL, [args.kind, args.id]);
    return (del.rows as Row[]).length > 0 ? { kind: 'released' } : { kind: 'not_taken' };
  } catch (err) {
    console.error('[manager-queue] отметка «взял» не снята, SQLSTATE', (err as { code?: string } | null)?.code ?? 'нет');
    return { kind: 'failed' };
  }
}
