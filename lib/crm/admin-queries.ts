/**
 * lib/crm/admin-queries.ts — клиенты всех партнёров для администратора
 * (CRM #2325; решение владельца 09.10: «все клиенты всех партнёров»).
 *
 * Только чтение: администратор видит, у какого партнёра клиент, откуда
 * пришёл и когда, но метки и заметки партнёров не правит — это записи
 * партнёра о своём клиенте. Отдельный модуль намеренно: в
 * `contact-queries.ts` каждый SQL скоупится партнёром (сторож
 * crm-contacts-api), а здесь скоупа нет по замыслу — и звать этот модуль
 * можно только из роутов под requireAdmin (тот же сторож).
 */
import { pool } from '@/lib/db-pool';
import { buildContactSearch, getContactCard, type ContactCard, type ContactListItem } from '@/lib/crm/contact-queries';
import type { PartnerCategory } from '@/lib/crm/partner-context';
import type { CrmContactRow } from '@/lib/types/db-rows';

interface Queryable {
  query: typeof pool.query;
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

export interface PartnerRef {
  id: string;
  name: string;
  category: string;
}

export type AdminContactListItem = ContactListItem & { partner: PartnerRef };

export interface AdminListParams {
  q?: string | null;
  tag?: string | null;
  category?: PartnerCategory | null;
  partnerId?: string | null;
  limit: number;
  offset: number;
}

const ADMIN_FILTER = `
     ($2::text IS NULL OR lower(coalesce(c.display_name, '')) LIKE $2 OR coalesce(c.email_norm, '') LIKE $2)
     AND ($3::text IS NULL OR coalesce(c.phone_e164, '') LIKE $3)
     AND ($4::text IS NULL OR $4 = ANY(c.tags))
     AND ($5::text IS NULL OR p.category = $5)
     AND ($1::uuid IS NULL OR c.partner_id = $1)`;

/** $1 партнёр, $2 имя/почта LIKE, $3 телефон LIKE, $4 метка, $5 роль, $6 лимит, $7 сдвиг. */
export const ADMIN_CONTACT_LIST_SQL = `
  SELECT c.id, c.display_name, c.phone, c.email, c.tags, c.origin,
         c.first_seen_at, c.last_activity_at,
         (c.pd_consent_at IS NOT NULL) AS consent_recorded,
         (SELECT count(*)::int FROM crm_contact_links l WHERE l.contact_id = c.id) AS sources_count,
         p.id AS partner_id, p.name AS partner_name, p.category AS partner_category
    FROM crm_contacts c
    JOIN partners p ON p.id = c.partner_id
   WHERE ${ADMIN_FILTER}
   ORDER BY c.last_activity_at DESC, c.id
   LIMIT $6 OFFSET $7`;

export const ADMIN_CONTACT_COUNT_SQL = `
  SELECT count(*)::int AS total
    FROM crm_contacts c
    JOIN partners p ON p.id = c.partner_id
   WHERE ${ADMIN_FILTER}`;

/** Для фильтров экрана: роли и партнёры, у которых клиенты есть вообще. */
export const ADMIN_FACETS_SQL = `
  SELECT p.id, p.name, p.category, count(*)::int AS n
    FROM crm_contacts c
    JOIN partners p ON p.id = c.partner_id
   GROUP BY p.id, p.name, p.category
   ORDER BY n DESC, p.name
   LIMIT 300`;

export interface AdminFacets {
  categories: Array<{ category: string; n: number }>;
  partners: Array<PartnerRef & { n: number }>;
}

type AdminListRow = Pick<
  CrmContactRow,
  'id' | 'display_name' | 'phone' | 'email' | 'tags' | 'origin' | 'first_seen_at' | 'last_activity_at'
> & {
  consent_recorded: boolean;
  sources_count: number;
  partner_id: string;
  partner_name: string;
  partner_category: string;
};

export async function listAllContacts(
  p: AdminListParams,
  db: Queryable = pool,
): Promise<{ items: AdminContactListItem[]; total: number; facets: AdminFacets }> {
  const s = buildContactSearch(p.q);
  const tag = p.tag?.trim() || null;
  const filter = [p.partnerId ?? null, s.name, s.phone, tag, p.category ?? null];
  const [rows, count, facets] = await Promise.all([
    db.query<AdminListRow>(ADMIN_CONTACT_LIST_SQL, [...filter, p.limit, p.offset]),
    db.query<{ total: number }>(ADMIN_CONTACT_COUNT_SQL, filter),
    db.query<PartnerRef & { n: number }>(ADMIN_FACETS_SQL),
  ]);
  const byCategory = new Map<string, number>();
  for (const f of facets.rows) byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + f.n);
  return {
    items: rows.rows.map((r) => ({
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
      partner: { id: r.partner_id, name: r.partner_name, category: r.partner_category },
    })),
    total: count.rows[0]?.total ?? 0,
    facets: {
      categories: [...byCategory.entries()].map(([category, n]) => ({ category, n })).sort((a, b) => b.n - a.n),
      partners: facets.rows,
    },
  };
}

export type AdminContactCard = ContactCard & { partner: PartnerRef };

/**
 * Карточка любого клиента с его партнёром. Сводка источников — та же, что
 * видит партнёр (getContactCard), чтобы два экрана не разошлись в том, что
 * показывают.
 */
export async function getContactCardForAdmin(
  contactId: string,
  db: Queryable = pool,
): Promise<AdminContactCard | null> {
  const owner = await db.query<PartnerRef>(
    `SELECT p.id, p.name, p.category
       FROM crm_contacts c
       JOIN partners p ON p.id = c.partner_id
      WHERE c.id = $1::uuid`,
    [contactId],
  );
  const partner = owner.rows[0];
  if (!partner) return null;
  const card = await getContactCard(partner.id, contactId, db);
  return card ? { ...card, partner } : null;
}
