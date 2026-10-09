/**
 * lib/crm/contact-queries.ts — чтение и правка клиентов партнёра для экрана,
 * Кузьмича и MCP (одна функция на три поверхности, #2325).
 *
 * Каждый запрос скоупится `partner_id` вошедшего партнёра в самом SQL: чужой
 * контакт не находится, а не «находится и отсекается» кодом после.
 */
import { pool } from '@/lib/db-pool';
import { normalizeEmail, normalizeName, normalizePhoneKey, type SourceKind } from '@/lib/crm/contacts';
import type { CrmContactLinkRow, CrmContactRow } from '@/lib/types/db-rows';
import { listContactEvents, type ContactEvent } from '@/lib/crm/events';

interface Queryable {
  query: typeof pool.query;
}

/** Время для ответа: pg отдаёт timestamptz как Date, наружу уходит ISO. */
function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

export interface ContactListItem {
  id: string;
  display_name: string | null;
  phone: string | null;
  email: string | null;
  tags: string[];
  origin: string;
  first_seen_at: string;
  last_activity_at: string;
  consent_recorded: boolean;
  sources_count: number;
}

/** Экранирование LIKE: % и _ из запроса человека — буквы, а не шаблон. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export interface ListParams {
  q?: string | null;
  tag?: string | null;
  limit: number;
  offset: number;
}

/**
 * Поиск: четыре и больше цифр — по телефону (хвост номера), иначе — по имени
 * и почте. Пустой запрос — все, свежие сверху.
 */
export function buildContactSearch(q: string | null | undefined): { name: string | null; phone: string | null } {
  const s = (q ?? '').trim();
  if (!s) return { name: null, phone: null };
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 4 && /^[\d\s()+-]+$/.test(s)) return { name: null, phone: `%${digits}%` };
  return { name: `%${likeEscape(s.toLowerCase())}%`, phone: null };
}

export const CONTACT_LIST_SQL = `
  SELECT c.id, c.display_name, c.phone, c.email, c.tags, c.origin,
         c.first_seen_at, c.last_activity_at,
         (c.pd_consent_at IS NOT NULL) AS consent_recorded,
         (SELECT count(*)::int FROM crm_contact_links l WHERE l.contact_id = c.id) AS sources_count
    FROM crm_contacts c
   WHERE c.partner_id = $1
     AND ($2::text IS NULL OR lower(coalesce(c.display_name, '')) LIKE $2 OR coalesce(c.email_norm, '') LIKE $2)
     AND ($3::text IS NULL OR coalesce(c.phone_e164, '') LIKE $3)
     AND ($4::text IS NULL OR $4 = ANY(c.tags))
   ORDER BY c.last_activity_at DESC, c.id
   LIMIT $5 OFFSET $6`;

export const CONTACT_COUNT_SQL = `
  SELECT count(*)::int AS total
    FROM crm_contacts c
   WHERE c.partner_id = $1
     AND ($2::text IS NULL OR lower(coalesce(c.display_name, '')) LIKE $2 OR coalesce(c.email_norm, '') LIKE $2)
     AND ($3::text IS NULL OR coalesce(c.phone_e164, '') LIKE $3)
     AND ($4::text IS NULL OR $4 = ANY(c.tags))`;

type ContactListRow = Pick<
  CrmContactRow,
  'id' | 'display_name' | 'phone' | 'email' | 'tags' | 'origin' | 'first_seen_at' | 'last_activity_at'
> & { consent_recorded: boolean; sources_count: number };

export async function listContacts(
  partnerId: string,
  p: ListParams,
  db: Queryable = pool,
): Promise<{ items: ContactListItem[]; total: number }> {
  const s = buildContactSearch(p.q);
  const tag = p.tag?.trim() || null;
  const [rows, count] = await Promise.all([
    db.query<ContactListRow>(CONTACT_LIST_SQL, [partnerId, s.name, s.phone, tag, p.limit, p.offset]),
    db.query<{ total: number }>(CONTACT_COUNT_SQL, [partnerId, s.name, s.phone, tag]),
  ]);
  return {
    items: rows.rows.map((r) => ({
      ...r,
      first_seen_at: iso(r.first_seen_at),
      last_activity_at: iso(r.last_activity_at),
    })),
    total: count.rows[0]?.total ?? 0,
  };
}

export interface ContactCard {
  id: string;
  display_name: string | null;
  phone: string | null;
  email: string | null;
  tags: string[];
  notes: string | null;
  origin: string;
  has_account: boolean;
  consent: { recorded_at: string; source: string | null; version: string | null } | null;
  first_seen_at: string;
  last_activity_at: string;
  sources: SourceSummary[];
  /** Лента, свежее сверху (до 50 событий). */
  events: ContactEvent[];
}

/** Источник в карточке: что это было, когда, в каком состоянии и как источник назвал человека. */
export interface SourceSummary {
  kind: SourceKind;
  id: string;
  occurred_at: string;
  title: string | null;
  date_from: string | null;
  date_to: string | null;
  status: string | null;
  people: number | null;
  person_name: string | null;
}

/**
 * Сводка источников по видам. Деньги в сводку не идут: карточка — о людях,
 * деньги остаются на своих экранах. Имя человека — по тому же правилу, что
 * у самого контакта (шапка lib/crm/contacts.ts).
 */
export const SOURCE_SUMMARY_SQL: Readonly<Record<SourceKind, string>> = {
  operator_booking: `
    SELECT b.id::text AS id, t.title, b.booking_date::text AS date_from, b.end_date::text AS date_to,
           b.booking_status AS status, b.participants AS people,
           COALESCE(NULLIF(btrim(b.tourist_name), ''), u.name) AS person_name
      FROM operator_bookings b
      JOIN operator_tours t ON t.id = b.operator_tour_id
      LEFT JOIN users u ON u.id = b.user_id
     WHERE b.id = ANY($1::bigint[])`,
  accommodation_booking: `
    SELECT ab.id::text AS id, a.name AS title, ab.check_in_date::text AS date_from,
           ab.check_out_date::text AS date_to, ab.status,
           (ab.adults + COALESCE(ab.children, 0)) AS people, u.name AS person_name
      FROM accommodation_bookings ab
      JOIN accommodations a ON a.id = ab.accommodation_id
      LEFT JOIN users u ON u.id = ab.user_id
     WHERE ab.id = ANY($1::uuid[])`,
  gear_rental: `
    SELECT gr.id::text AS id, gi.name AS title, gr.start_date::text AS date_from,
           gr.end_date::text AS date_to, gr.status, gr.quantity AS people,
           gr.customer_name AS person_name
      FROM gear_rentals gr
      JOIN gear_items gi ON gi.id = gr.gear_id
     WHERE gr.id = ANY($1::uuid[])`,
  transfer_seat_booking: `
    SELECT sb.id::text AS id, (tr.from_text || ' — ' || tr.to_text) AS title,
           tr.trip_date::text AS date_from, NULL::text AS date_to, sb.status, sb.seats AS people,
           op.name AS person_name
      FROM transfer_seat_bookings sb
      JOIN transfer_trips tr ON tr.id = sb.trip_id
      LEFT JOIN partners op ON op.id = sb.ordered_by_partner_id
     WHERE sb.id = ANY($1::uuid[])`,
  // У лида желаемые даты — текстом, как их написал человек («вторая половина июля»).
  lead: `
    SELECT l.id::text AS id, l.route_title AS title, l.desired_dates AS date_from, NULL::text AS date_to,
           l.status, l.group_size::int AS people, l.name AS person_name
      FROM leads l
     WHERE l.id = ANY($1::uuid[])`,
  agent_client: `
    SELECT c.id::text AS id, c.company AS title, NULL::text AS date_from, NULL::text AS date_to,
           c.status, NULL::int AS people, c.name AS person_name
      FROM agent_clients c
     WHERE c.id = ANY($1::uuid[])`,
};

export async function getContactCard(
  partnerId: string,
  contactId: string,
  db: Queryable = pool,
): Promise<ContactCard | null> {
  const c = await db.query<Pick<
    CrmContactRow,
    'id' | 'display_name' | 'phone' | 'email' | 'tags' | 'notes' | 'origin' | 'user_id'
    | 'pd_consent_at' | 'pd_consent_source' | 'pd_consent_version' | 'first_seen_at' | 'last_activity_at'
  >>(
    `SELECT id, display_name, phone, email, tags, notes, origin, user_id,
            pd_consent_at, pd_consent_source, pd_consent_version, first_seen_at, last_activity_at
       FROM crm_contacts
      WHERE id = $1::uuid AND partner_id = $2`,
    [contactId, partnerId],
  );
  const row = c.rows[0];
  if (!row) return null;

  const links = await db.query<Pick<CrmContactLinkRow, 'source_id' | 'occurred_at'> & { source_kind: SourceKind }>(
    `SELECT source_kind, source_id, occurred_at
       FROM crm_contact_links
      WHERE contact_id = $1 AND partner_id = $2
      ORDER BY occurred_at DESC
      LIMIT 100`,
    [contactId, partnerId],
  );

  const events = await listContactEvents(partnerId, contactId, 50, db);

  const byKind = new Map<SourceKind, string[]>();
  for (const l of links.rows) byKind.set(l.source_kind, [...(byKind.get(l.source_kind) ?? []), l.source_id]);
  const details = new Map<string, Omit<SourceSummary, 'kind' | 'occurred_at'>>();
  await Promise.all(
    [...byKind.entries()].map(async ([kind, ids]) => {
      const r = await db.query<Omit<SourceSummary, 'kind' | 'occurred_at'>>(SOURCE_SUMMARY_SQL[kind], [ids]);
      for (const d of r.rows) details.set(`${kind}:${d.id}`, d);
    }),
  );

  return {
    id: row.id,
    display_name: row.display_name,
    phone: row.phone,
    email: row.email,
    tags: row.tags,
    notes: row.notes,
    origin: row.origin,
    has_account: row.user_id !== null,
    consent: row.pd_consent_at
      ? { recorded_at: iso(row.pd_consent_at), source: row.pd_consent_source, version: row.pd_consent_version }
      : null,
    first_seen_at: iso(row.first_seen_at),
    last_activity_at: iso(row.last_activity_at),
    events,
    sources: links.rows.map((l) => {
      const d = details.get(`${l.source_kind}:${l.source_id}`);
      // Источник удалён после привязки — связь остаётся, сведения пустые.
      return {
        kind: l.source_kind,
        id: l.source_id,
        occurred_at: iso(l.occurred_at),
        title: d?.title ?? null,
        date_from: d?.date_from ?? null,
        date_to: d?.date_to ?? null,
        status: d?.status ?? null,
        people: d?.people ?? null,
        person_name: d?.person_name ?? null,
      };
    }),
  };
}

export interface ManualContactInput {
  display_name: string;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  tags?: string[];
}

export type CreateManualResult =
  | { outcome: 'created'; id: string }
  | { outcome: 'exists'; id: string }
  | { outcome: 'bad_phone' };

/**
 * Клиент, заведённый партнёром руками (звонок, знакомый). Согласие — NULL:
 * его партнёр не собирал на платформе, и записывать «да» не за что.
 */
export async function createManualContact(
  partnerId: string,
  input: ManualContactInput,
  db: Queryable = pool,
): Promise<CreateManualResult> {
  const name = normalizeName(input.display_name);
  const phone = input.phone?.trim() || null;
  const phoneE164 = phone ? normalizePhoneKey(phone) : null;
  if (phone && !phoneE164) return { outcome: 'bad_phone' };
  const email = input.email?.trim() || null;
  const emailNorm = normalizeEmail(email);

  if (phoneE164 || emailNorm) {
    const dup = await db.query<{ id: string }>(
      `SELECT id FROM crm_contacts
        WHERE partner_id = $1
          AND (($2::text IS NOT NULL AND phone_e164 = $2) OR ($3::text IS NOT NULL AND email_norm = $3))
        ORDER BY created_at, id LIMIT 1`,
      [partnerId, phoneE164, emailNorm],
    );
    if (dup.rows[0]) return { outcome: 'exists', id: dup.rows[0].id };
  }

  const ins = await db.query<{ id: string }>(
    `INSERT INTO crm_contacts
       (partner_id, display_name, phone, phone_e164, email, email_norm, origin, notes, tags)
     VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7, $8)
     RETURNING id`,
    [partnerId, name, phone, phoneE164, email, emailNorm, input.notes?.trim() || null, input.tags ?? []],
  );
  return { outcome: 'created', id: ins.rows[0].id };
}

export interface ContactPatch {
  display_name?: string;
  notes?: string | null;
  tags?: string[];
}

export async function updateContact(
  partnerId: string,
  contactId: string,
  patch: ContactPatch,
  db: Queryable = pool,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE crm_contacts SET
       display_name = CASE WHEN $3::boolean THEN $4 ELSE display_name END,
       notes        = CASE WHEN $5::boolean THEN $6 ELSE notes END,
       tags         = CASE WHEN $7::boolean THEN $8::text[] ELSE tags END,
       updated_at   = NOW()
     WHERE id = $1::uuid AND partner_id = $2`,
    [
      contactId, partnerId,
      patch.display_name !== undefined, patch.display_name !== undefined ? normalizeName(patch.display_name) : null,
      patch.notes !== undefined, patch.notes?.trim() || null,
      patch.tags !== undefined, patch.tags ?? [],
    ],
  );
  return (r.rowCount ?? 0) > 0;
}
