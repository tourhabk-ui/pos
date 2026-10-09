/**
 * lib/crm/operator-clients.ts — «Клиенты» оператора на контактах CRM: суммы
 * броней и сегмент (CRM #2325, шаг 1а-2b).
 *
 * Прежний экран (`/api/operator/clients`, до 10.10) строился от `users` через
 * брони оператора — видел только туристов с аккаунтом: гостевая бронь, лид и
 * клиент, заведённый руками, в «Клиенты» не попадали. Теперь список — контакты
 * CRM оператора, а суммы и сегмент считаются по броням, привязанным к контакту
 * (`crm_contact_links`, вид `operator_booking`).
 *
 * Что взято у старого экрана и что поправлено:
 *  - сумма — подтверждённые и завершённые брони по цене брони, как было. Это
 *    НЕ оплата: приём оплаты через платформу выключен (05.10), и называть
 *    сумму «потрачено» значило бы выдать заказ за деньги;
 *  - число броней — без отменённых и отклонённых: старый счёт включал их, и
 *    три отменённые брони делали клиента VIP;
 *  - сегмент — тем же правилом (3+ брони или 100 000 ₽ — VIP, бронь за 90
 *    дней — активный, иначе неактивный) и четвёртым исходом «без броней»: у
 *    лида и ручного клиента брони нет, и «неактивным» он не был никогда.
 *
 * SQL — один неизменный текст с параметрами, без сборки строк: его разбирает
 * PREPARE на проде (`/api/cron/operator-screens-check`) и исполняет
 * интеграционный тест на настоящем PostgreSQL. Сборка текста во время работы
 * дала бы сочетания, которые не проверил никто (так 10.09 упал старый экран).
 */
import { pool } from '@/lib/db-pool';
import { buildContactSearch, type ContactListItem } from '@/lib/crm/contact-queries';
import { FREEING_BOOKING_STATUSES } from '@/lib/bookings/occupancy';
import {
  OPERATOR_SEGMENTS, VIP_MIN_BOOKINGS, VIP_MIN_SUM_RUB, ACTIVE_DAYS,
  type OperatorSegment, type OperatorSort,
} from '@/lib/crm/operator-segments';

export { OPERATOR_SEGMENTS, OPERATOR_SORTS, type OperatorSegment, type OperatorSort } from '@/lib/crm/operator-segments';

interface Queryable {
  query: typeof pool.query;
}

/** Отменённая или отклонённая бронь не считается ни в число, ни в «последнюю». */
const FREEING = FREEING_BOOKING_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * Параметры: $1 partner_id, $2 имя/почта (LIKE) или NULL, $3 хвост телефона
 * или NULL, $4 метка или NULL — те же, что у списка контактов любого партнёра.
 */
const SEGMENTED_CTE = `
  WITH st AS (
    SELECT c.id, c.display_name, c.phone, c.email, c.tags, c.origin,
           c.first_seen_at, c.last_activity_at,
           (c.pd_consent_at IS NOT NULL) AS consent_recorded,
           (SELECT count(*)::int FROM crm_contact_links cl WHERE cl.contact_id = c.id) AS sources_count,
           COALESCE(s.bookings, 0)::int AS bookings,
           COALESCE(s.booked_sum, 0)::numeric AS booked_sum,
           s.last_booking_at
      FROM crm_contacts c
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE b.booking_status NOT IN (${FREEING})) AS bookings,
               SUM(COALESCE(b.final_price, b.base_total_price))
                 FILTER (WHERE b.booking_status IN ('confirmed', 'completed')) AS booked_sum,
               MAX(b.created_at) FILTER (WHERE b.booking_status NOT IN (${FREEING})) AS last_booking_at
          FROM crm_contact_links l
          JOIN operator_bookings b ON b.id::text = l.source_id
         WHERE l.contact_id = c.id
           AND l.partner_id = c.partner_id
           AND l.source_kind = 'operator_booking'
           AND b.deleted_at IS NULL
      ) s ON TRUE
     WHERE c.partner_id = $1
       AND ($2::text IS NULL OR lower(coalesce(c.display_name, '')) LIKE $2 OR coalesce(c.email_norm, '') LIKE $2)
       AND ($3::text IS NULL OR coalesce(c.phone_e164, '') LIKE $3)
       AND ($4::text IS NULL OR $4 = ANY(c.tags))
  ),
  seg AS (
    SELECT st.*,
           CASE
             WHEN st.bookings = 0 THEN 'none'
             WHEN st.bookings >= ${VIP_MIN_BOOKINGS} OR st.booked_sum >= ${VIP_MIN_SUM_RUB} THEN 'vip'
             WHEN st.last_booking_at >= NOW() - INTERVAL '${ACTIVE_DAYS} days' THEN 'active'
             ELSE 'inactive'
           END AS segment
      FROM st
  )`;

/** $5 сегмент или NULL, $6 порядок (`OperatorSort`), $7 limit, $8 offset. */
export const OPERATOR_CLIENTS_LIST_SQL = `${SEGMENTED_CTE}
  SELECT * FROM seg
   WHERE ($5::text IS NULL OR segment = $5)
   ORDER BY CASE WHEN $6::text = 'sum' THEN booked_sum END DESC NULLS LAST,
            CASE WHEN $6::text = 'bookings' THEN bookings END DESC NULLS LAST,
            last_activity_at DESC, id
   LIMIT $7 OFFSET $8`;

/** $5 сегмент или NULL. */
export const OPERATOR_CLIENTS_COUNT_SQL = `${SEGMENTED_CTE}
  SELECT count(*)::int AS total FROM seg WHERE ($5::text IS NULL OR segment = $5)`;

/** Итоги по всей базе оператора — плитки над списком (не по странице, как было). */
export const OPERATOR_CLIENTS_SUMMARY_SQL = `${SEGMENTED_CTE}
  SELECT count(*)::int AS clients,
         count(*) FILTER (WHERE segment = 'vip')::int AS vip,
         COALESCE(SUM(bookings), 0)::int AS bookings,
         COALESCE(SUM(booked_sum), 0)::numeric AS booked_sum
    FROM seg`;

export interface OperatorClientStats {
  bookings: number;
  /** Сумма подтверждённых и завершённых броней, ₽. Не оплата. */
  booked_sum: number;
  last_booking_at: string | null;
  segment: OperatorSegment;
}

export type OperatorClientItem = ContactListItem & { stats: OperatorClientStats };

export interface OperatorClientsSummary {
  clients: number;
  vip: number;
  bookings: number;
  booked_sum: number;
}

export interface OperatorListParams {
  q?: string | null;
  tag?: string | null;
  segment?: OperatorSegment | null;
  sort?: OperatorSort | null;
  limit: number;
  offset: number;
}

interface SegRow {
  id: string;
  display_name: string | null;
  phone: string | null;
  email: string | null;
  tags: string[];
  origin: string;
  first_seen_at: Date | string;
  last_activity_at: Date | string;
  consent_recorded: boolean;
  sources_count: number;
  bookings: number;
  booked_sum: string | number;
  last_booking_at: Date | string | null;
  segment: string;
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** Неизвестный сегмент из базы не выдаётся за «без броней»: это отказ формы запроса. */
function segmentOf(s: string): OperatorSegment {
  if ((OPERATOR_SEGMENTS as readonly string[]).includes(s)) return s as OperatorSegment;
  throw new Error(`неизвестный сегмент клиента: ${s}`);
}

/** Строка запроса → элемент списка. pg отдаёт numeric строкой — в число здесь. */
export function toOperatorItem(r: SegRow): OperatorClientItem {
  return {
    id: r.id,
    display_name: r.display_name,
    phone: r.phone,
    email: r.email,
    tags: r.tags,
    origin: r.origin,
    first_seen_at: iso(r.first_seen_at),
    last_activity_at: iso(r.last_activity_at),
    consent_recorded: r.consent_recorded,
    sources_count: r.sources_count,
    stats: {
      bookings: r.bookings,
      booked_sum: Number(r.booked_sum),
      last_booking_at: r.last_booking_at ? iso(r.last_booking_at) : null,
      segment: segmentOf(r.segment),
    },
  };
}

export async function listOperatorClients(
  partnerId: string,
  p: OperatorListParams,
  db: Queryable = pool,
): Promise<{ items: OperatorClientItem[]; total: number; summary: OperatorClientsSummary }> {
  const s = buildContactSearch(p.q);
  const tag = p.tag?.trim() || null;
  const segment = p.segment ?? null;
  const sort: OperatorSort = p.sort ?? 'recent';
  const [rows, count, summary] = await Promise.all([
    db.query<SegRow>(OPERATOR_CLIENTS_LIST_SQL, [partnerId, s.name, s.phone, tag, segment, sort, p.limit, p.offset]),
    db.query<{ total: number }>(OPERATOR_CLIENTS_COUNT_SQL, [partnerId, s.name, s.phone, tag, segment]),
    db.query<{ clients: number; vip: number; bookings: number; booked_sum: string | number }>(
      OPERATOR_CLIENTS_SUMMARY_SQL,
      [partnerId, null, null, null],
    ),
  ]);
  const sm = summary.rows[0];
  return {
    items: rows.rows.map(toOperatorItem),
    total: count.rows[0]?.total ?? 0,
    summary: {
      clients: sm?.clients ?? 0,
      vip: sm?.vip ?? 0,
      bookings: sm?.bookings ?? 0,
      booked_sum: Number(sm?.booked_sum ?? 0),
    },
  };
}
