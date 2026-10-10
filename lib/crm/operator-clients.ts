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
 * SQL — в `lib/crm/operator-clients-sql.ts`: один неизменный текст с
 * параметрами, без сборки строк. Его разбирает PREPARE на проде
 * (`/api/cron/operator-screens-check`) и исполняет интеграционный тест на
 * настоящем PostgreSQL.
 */
import { pool } from '@/lib/db-pool';
import { buildContactSearch, type ContactListItem } from '@/lib/crm/contact-queries';
import { OPERATOR_SEGMENTS, type OperatorSegment, type OperatorSort } from '@/lib/crm/operator-segments';
import {
  OPERATOR_CLIENTS_LIST_SQL, OPERATOR_CLIENTS_COUNT_SQL, OPERATOR_CLIENTS_SUMMARY_SQL,
} from '@/lib/crm/operator-clients-sql';

export { OPERATOR_SEGMENTS, OPERATOR_SORTS, type OperatorSegment, type OperatorSort } from '@/lib/crm/operator-segments';

export {
  OPERATOR_CLIENTS_LIST_SQL, OPERATOR_CLIENTS_COUNT_SQL, OPERATOR_CLIENTS_SUMMARY_SQL,
} from '@/lib/crm/operator-clients-sql';

interface Queryable {
  query: typeof pool.query;
}

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
