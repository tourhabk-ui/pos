/**
 * lib/crm/contacts.ts — клиент партнёра: склейка из источников (CRM фаза 1,
 * шаг 1а, #2325).
 *
 * Источник — строка, в которой партнёр впервые узнал человека: бронь тура,
 * бронь жилья, заказ проката, место в машине, лид, клиент агента. Каждая знает
 * человека по-своему (у гостя нет аккаунта, у проката нет аккаунта вовсе, у
 * перевозчика бывает только телефон), поэтому чтение источника — свой SQL на
 * вид, а склейка — одна.
 *
 * Склейка внутри ОДНОГО партнёра: телефон в E.164 → почта → аккаунт. Разные
 * партнёры — разные контакты всегда: ПД не перетекают между партнёрами.
 * Один телефон у двух имён — один контакт: для связи телефон и есть личность,
 * а имя, записанное источником, видно в карточке у каждого источника.
 *
 * CRM не расширяет доступ к ПД. В контакт попадают ровно те поля, которые
 * партнёр уже получает по этому источнику — на экранах и в уведомлении о брони:
 *   - оператор — имя, телефон и почту из брони, а где брони сказать нечего — из
 *     аккаунта туриста (так их показывают «Клиенты» оператора,
 *     `lib/operator/screen-queries.ts`);
 *   - владелец жилья — имя, телефон и почту гостя из аккаунта (экран броней и
 *     уведомление о брони `notifyNewStayBooking`);
 *   - перевозчик — телефон заказа и имя заказавшего партнёра, без имени и
 *     почты аккаунта туриста (`listSeatRequests`);
 *   - гиду контакты из броней не копируются вовсе: его доступ к туристу
 *     временный — назначение, команда оператора, предстоящая бронь
 *     (`lib/guides/team-queries.ts`), а контакт постоянный;
 *   - запрос мест — не источник: контакты туриста оператор получает только
 *     после «есть места» (решение 29.09, `lib/seat-requests/service.ts`), и
 *     тогда клиента заводит бронь.
 *
 * Согласие копируется из источника, где оно записано (брони туров, лиды), и
 * только в контакт, у которого его ещё нет.
 */
import { normalizePhone } from '@/lib/mcp/normalize-phone';
import { pool } from '@/lib/db-pool';
import type { PoolClient } from 'pg';

export const SOURCE_KINDS = [
  'operator_booking',
  'accommodation_booking',
  'gear_rental',
  'transfer_seat_booking',
  'lead',
  'agent_client',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export function isSourceKind(v: unknown): v is SourceKind {
  return typeof v === 'string' && (SOURCE_KINDS as readonly string[]).includes(v);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Брони туров — bigint, остальные источники — uuid. */
export function isValidSourceId(kind: SourceKind, id: string): boolean {
  return kind === 'operator_booking' ? /^\d{1,18}$/.test(id) : UUID_RE.test(id);
}

/** Колонки, которые отдаёт SQL любого источника: человек и его партнёр. */
export interface SourcePersonRow {
  partner_id: string;
  user_id: string | null;
  person_name: string | null;
  phone: string | null;
  email: string | null;
  pd_consent_at: Date | string | null;
  pd_consent_ip: string | null;
  pd_consent_source: string | null;
  pd_consent_version: string | null;
  occurred_at: Date | string;
}

const NO_CONSENT = `NULL::timestamptz AS pd_consent_at, NULL::varchar AS pd_consent_ip,
       NULL::varchar AS pd_consent_source, NULL::varchar AS pd_consent_version`;

/**
 * Как читать человека из источника. Строка источника — под псевдонимом `s`.
 * `eligible` — годится ли строка в клиента вообще (есть партнёр, не удалена,
 * не проба владельца); по нему же задел ищет непривязанное, поэтому хук и
 * задел не могут разойтись в том, что считать источником.
 */
interface SourceSpec {
  idType: 'bigint' | 'uuid';
  from: string;
  person: string;
  eligible: string;
}

const SOURCE_SPECS: Readonly<Record<SourceKind, SourceSpec>> = {
  // Поле брони первым: его турист вписал под эту поездку. Аккаунт — где брони
  // сказать нечего, как в «Клиентах» оператора.
  operator_booking: {
    idType: 'bigint',
    from: `operator_bookings s
           JOIN operator_tours t ON t.id = s.operator_tour_id
           LEFT JOIN users u ON u.id = s.user_id`,
    person: `t.operator_id AS partner_id, s.user_id,
             COALESCE(NULLIF(btrim(s.tourist_name), ''), u.name) AS person_name,
             COALESCE(NULLIF(btrim(s.tourist_phone), ''), u.phone) AS phone,
             COALESCE(NULLIF(btrim(s.tourist_email), ''), u.email) AS email,
             s.pd_consent_at, s.pd_consent_ip, s.pd_consent_source, s.pd_consent_version,
             s.created_at::timestamptz AS occurred_at`,
    // Служебная бронь пробы оплаты (payment-test-setup, решение владельца
    // 23.08) — не клиент: у неё нет туриста по построению, а оператор —
    // служебный партнёр. Перепись 09.10 (run 104) нашла её единственной
    // непривязанной строкой, которую задел перебирал на каждом прогоне.
    eligible: `s.deleted_at IS NULL AND t.operator_id IS NOT NULL
               AND s.created_via IS DISTINCT FROM 'service-payment-test'`,
  },
  // В брони жилья человека нет — только аккаунт; владелец получает имя,
  // телефон и почту гостя в уведомлении о брони.
  accommodation_booking: {
    idType: 'uuid',
    from: `accommodation_bookings s
           JOIN accommodations a ON a.id = s.accommodation_id
           JOIN users u ON u.id = s.user_id`,
    person: `a.partner_id, s.user_id, u.name AS person_name, u.phone, u.email,
             ${NO_CONSENT}, s.created_at AS occurred_at`,
    eligible: `a.partner_id IS NOT NULL`,
  },
  gear_rental: {
    idType: 'uuid',
    from: `gear_rentals s JOIN gear_items gi ON gi.id = s.gear_id`,
    person: `gi.partner_id, NULL::uuid AS user_id, s.customer_name AS person_name,
             s.customer_phone AS phone, s.customer_email AS email,
             ${NO_CONSENT}, s.created_at AS occurred_at`,
    eligible: `gi.partner_id IS NOT NULL`,
  },
  // Заказчик места — турист (аккаунт) или партнёр, заказавший места своей
  // группе. Имя — только у партнёра: имени туриста перевозчик не видит.
  transfer_seat_booking: {
    idType: 'uuid',
    from: `transfer_seat_bookings s
           JOIN transfer_trips tr ON tr.id = s.trip_id
           JOIN transfer_fleet_vehicles v ON v.id = tr.vehicle_id
           LEFT JOIN partners op ON op.id = s.ordered_by_partner_id`,
    person: `v.partner_id, s.ordered_by_user_id AS user_id,
             op.name AS person_name, s.contact_phone AS phone, NULL::text AS email,
             ${NO_CONSENT}, s.created_at AS occurred_at`,
    eligible: `TRUE`,
  },
  // Лид без оператора — заявка платформе, у неё нет партнёра. Свой лид
  // владельца (проверка формы) клиентом не становится — как и в счёт спроса.
  lead: {
    idType: 'uuid',
    from: `leads s`,
    person: `s.operator_id AS partner_id, NULL::uuid AS user_id, s.name AS person_name,
             s.phone, s.email,
             s.pd_consent_at, s.pd_consent_ip, s.pd_consent_source, s.pd_consent_version,
             s.created_at AS occurred_at`,
    eligible: `s.operator_id IS NOT NULL AND s.is_self = FALSE`,
  },
  // Клиент агента ключуется по users.id агента — партнёр берётся тем же
  // правилом, что у профиля (самый ранний при задвоении).
  agent_client: {
    idType: 'uuid',
    from: `agent_clients s
           CROSS JOIN LATERAL (
             SELECT id FROM partners
              WHERE user_id = s.agent_id AND category = 'agent'
              ORDER BY created_at ASC NULLS LAST, id ASC
              LIMIT 1
           ) p`,
    person: `p.id AS partner_id, NULL::uuid AS user_id, s.name AS person_name, s.phone, s.email,
             ${NO_CONSENT}, s.created_at::timestamptz AS occurred_at`,
    eligible: `TRUE`,
  },
};

function bySpec(build: (kind: SourceKind, spec: SourceSpec) => string): Readonly<Record<SourceKind, string>> {
  return Object.fromEntries(
    SOURCE_KINDS.map((k) => [k, build(k, SOURCE_SPECS[k])]),
  ) as Record<SourceKind, string>;
}

const UNLINKED = (kind: SourceKind) =>
  `NOT EXISTS (SELECT 1 FROM crm_contact_links l
                WHERE l.source_kind = '${kind}' AND l.source_id = s.id::text)`;

/** Человек из одной строки источника. $1 — id строки; строк ноль или одна. */
export const SOURCE_SQL = bySpec((_, sp) => `
  SELECT ${sp.person}
    FROM ${sp.from}
   WHERE s.id = $1::${sp.idType} AND ${sp.eligible}`);

/**
 * Задел: следующая порция непривязанных строк, по возрастанию id. $1 — id,
 * после которого продолжать (курсор прогона), $2 — размер порции. Курсор, а
 * не «первые N непривязанных»: строка, из которой контакта не выходит
 * (ни имени, ни телефона), иначе возвращалась бы в каждую порцию.
 */
export const UNLINKED_PAGE_SQL = bySpec((kind, sp) => `
  SELECT s.id::text AS id
    FROM ${sp.from}
   WHERE ${sp.eligible} AND ${UNLINKED(kind)} AND s.id > $1::${sp.idType}
   ORDER BY s.id
   LIMIT $2`);

/**
 * Условие «годна в клиента и ещё не привязана» — одно на задел и на
 * переписи, которые обещают показать то же, что видит задел (алиас строки
 * источника — `s`). Копия условия в переписи разошлась с заделом в первый
 * же день (#2337: служебную бронь исключили здесь, а перепись её показывала).
 */
export const UNLINKED_WHERE = bySpec((kind, sp) => `${sp.eligible} AND ${UNLINKED(kind)}`);

/** Сколько строк источника ещё не привязано — для сухого прогона задела. */
export const UNLINKED_COUNT_SQL = bySpec((kind, sp) => `
  SELECT count(*)::int AS n
    FROM ${sp.from}
   WHERE ${sp.eligible} AND ${UNLINKED(kind)}`);

/** Начало курсора задела: меньше любого id источника. */
export function cursorStart(kind: SourceKind): string {
  return SOURCE_SPECS[kind].idType === 'bigint' ? '0' : '00000000-0000-0000-0000-000000000000';
}

// ── Нормализация ─────────────────────────────────────────────────────────────

export function normalizeName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 200) : null;
}

/** Почта как ключ: без пробелов, нижний регистр, есть «@» и точка после него. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/** Телефон как ключ — то же правило, что у заявок (lib/mcp/normalize-phone). */
export function normalizePhoneKey(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return normalizePhone(raw);
}

export interface PersonKey {
  name: string | null;
  phone: string | null;
  phoneE164: string | null;
  email: string | null;
  emailNorm: string | null;
  userId: string | null;
}

export function personKey(row: Pick<SourcePersonRow, 'person_name' | 'phone' | 'email' | 'user_id'>): PersonKey {
  const phone = typeof row.phone === 'string' && row.phone.trim() ? row.phone.trim().slice(0, 40) : null;
  const email = typeof row.email === 'string' && row.email.trim() ? row.email.trim().slice(0, 200) : null;
  return {
    name: normalizeName(row.person_name),
    phone,
    phoneE164: normalizePhoneKey(phone),
    email,
    emailNorm: normalizeEmail(email),
    userId: row.user_id ?? null,
  };
}

/** По чему склеивается человек: первый непустой ключ. none — склеивать не по чему. */
export function keyKind(k: PersonKey): 'phone' | 'email' | 'user' | 'none' {
  if (k.phoneE164) return 'phone';
  if (k.emailNorm) return 'email';
  if (k.userId) return 'user';
  return 'none';
}

// ── Склейка ──────────────────────────────────────────────────────────────────

export interface CrmDb {
  query: typeof pool.query;
  connect: () => Promise<PoolClient>;
}

export type LinkResult =
  | { outcome: 'linked'; partnerId: string; contactId: string; created: boolean }
  | { outcome: 'no_source' }
  | { outcome: 'no_contact' }
  | { outcome: 'bad_id' }
  | { outcome: 'failed'; reason: string };

function sqlstate(err: unknown): string {
  return (err as { code?: string })?.code ?? 'нет SQLSTATE';
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/**
 * Найти или завести контакт человека у партнёра и привязать к нему источник.
 * Всё в одной транзакции: контакт без связи с источником не остаётся. Гонка
 * двух привязок одного источника решается уникальностью связи: проигравший
 * откатывается и читает победителя.
 */
async function linkOne(
  client: PoolClient,
  kind: SourceKind,
  sourceId: string,
  row: SourcePersonRow,
): Promise<{ contactId: string; created: boolean } | 'no_contact'> {
  const existing = await client.query<{ contact_id: string }>(
    `SELECT contact_id FROM crm_contact_links WHERE source_kind = $1 AND source_id = $2`,
    [kind, sourceId],
  );
  if (existing.rows[0]) return { contactId: existing.rows[0].contact_id, created: false };

  const k = personKey(row);
  const kk = keyKind(k);
  if (kk === 'none' && !k.name) return 'no_contact';

  const occurred = iso(row.occurred_at);
  const consent = row.pd_consent_at
    ? [iso(row.pd_consent_at), row.pd_consent_ip, row.pd_consent_source, row.pd_consent_version]
    : [null, null, null, null];

  await client.query('BEGIN');
  try {
    let contactId: string | null = null;
    let created = false;

    const find = async (sql: string, params: unknown[]): Promise<string | null> =>
      (await client.query<{ id: string }>(sql, params)).rows[0]?.id ?? null;

    if (kk === 'phone') {
      contactId = await find(
        `SELECT id FROM crm_contacts WHERE partner_id = $1 AND phone_e164 = $2 FOR UPDATE`,
        [row.partner_id, k.phoneE164],
      );
      // Человек уже известен по почте или аккаунту без телефона — телефон
      // дописывается ему, а не заводит второго.
      if (!contactId && k.emailNorm) {
        contactId = await find(
          `SELECT id FROM crm_contacts
            WHERE partner_id = $1 AND email_norm = $2 AND phone_e164 IS NULL
            ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
          [row.partner_id, k.emailNorm],
        );
      }
      if (!contactId && k.userId) {
        contactId = await find(
          `SELECT id FROM crm_contacts
            WHERE partner_id = $1 AND user_id = $2 AND phone_e164 IS NULL
            ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
          [row.partner_id, k.userId],
        );
      }
      if (contactId) {
        await client.query(
          `UPDATE crm_contacts SET phone = COALESCE(phone, $2), phone_e164 = $3 WHERE id = $1 AND phone_e164 IS NULL`,
          [contactId, k.phone, k.phoneE164],
        );
      }
    } else if (kk === 'email') {
      contactId = await find(
        `SELECT id FROM crm_contacts
          WHERE partner_id = $1 AND email_norm = $2
          ORDER BY (phone_e164 IS NULL), created_at, id LIMIT 1 FOR UPDATE`,
        [row.partner_id, k.emailNorm],
      );
    } else if (kk === 'user') {
      contactId = await find(
        `SELECT id FROM crm_contacts
          WHERE partner_id = $1 AND user_id = $2
          ORDER BY (phone_e164 IS NULL AND email_norm IS NULL), created_at, id LIMIT 1 FOR UPDATE`,
        [row.partner_id, k.userId],
      );
    }

    if (!contactId) {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO crm_contacts
           (partner_id, user_id, display_name, phone, phone_e164, email, email_norm, origin,
            pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version,
            first_seen_at, last_activity_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
         RETURNING id`,
        [row.partner_id, k.userId, k.name, k.phone, k.phoneE164, k.email, k.emailNorm, kind, ...consent, occurred],
      );
      contactId = ins.rows[0].id;
      created = true;
    } else {
      // Дописать недостающее, не перетирая записанного. Почта дописывается
      // только контакту с телефоном: у контакта без телефона почта — ключ
      // склейки, и его нашли бы по ней раньше.
      await client.query(
        `UPDATE crm_contacts SET
           user_id          = COALESCE(user_id, $2),
           display_name     = COALESCE(display_name, $3),
           email            = CASE WHEN phone_e164 IS NOT NULL THEN COALESCE(email, $4) ELSE email END,
           email_norm       = CASE WHEN phone_e164 IS NOT NULL THEN COALESCE(email_norm, $5) ELSE email_norm END,
           pd_consent_ip      = CASE WHEN pd_consent_at IS NULL AND $6::timestamptz IS NOT NULL THEN $7 ELSE pd_consent_ip END,
           pd_consent_source  = CASE WHEN pd_consent_at IS NULL AND $6::timestamptz IS NOT NULL THEN $8 ELSE pd_consent_source END,
           pd_consent_version = CASE WHEN pd_consent_at IS NULL AND $6::timestamptz IS NOT NULL THEN $9 ELSE pd_consent_version END,
           pd_consent_at      = COALESCE(pd_consent_at, $6::timestamptz),
           first_seen_at    = LEAST(first_seen_at, $10::timestamptz),
           last_activity_at = GREATEST(last_activity_at, $10::timestamptz),
           updated_at       = NOW()
         WHERE id = $1`,
        [contactId, k.userId, k.name, k.email, k.emailNorm, ...consent, occurred],
      );
    }

    const link = await client.query<{ contact_id: string }>(
      `INSERT INTO crm_contact_links (contact_id, partner_id, source_kind, source_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_kind, source_id) DO NOTHING
       RETURNING contact_id`,
      [contactId, row.partner_id, kind, sourceId, occurred],
    );
    if (!link.rows[0]) {
      // Источник успели привязать параллельно — наш контакт не нужен.
      await client.query('ROLLBACK');
      const winner = await client.query<{ contact_id: string }>(
        `SELECT contact_id FROM crm_contact_links WHERE source_kind = $1 AND source_id = $2`,
        [kind, sourceId],
      );
      return { contactId: winner.rows[0].contact_id, created: false };
    }
    await client.query('COMMIT');
    return { contactId, created };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/**
 * Привязать источник к контакту партнёра, который знает по нему человека.
 * Идемпотентно: повтор возвращает тот же контакт.
 */
export async function linkContactFromSource(
  kind: SourceKind,
  sourceId: string,
  db: CrmDb = pool,
): Promise<LinkResult> {
  if (!isValidSourceId(kind, sourceId)) return { outcome: 'bad_id' };
  let row: SourcePersonRow | undefined;
  try {
    row = (await db.query<SourcePersonRow>(SOURCE_SQL[kind], [sourceId])).rows[0];
  } catch (err) {
    console.error('[crm] источник не прочитан:', kind, 'SQLSTATE', sqlstate(err));
    return { outcome: 'failed', reason: `read ${sqlstate(err)}` };
  }
  if (!row) return { outcome: 'no_source' };

  // Уникальность телефона может столкнуться с параллельной вставкой того же
  // человека от другого источника — один повтор её разводит.
  for (let attempt = 0; ; attempt++) {
    const client = await db.connect();
    try {
      const r = await linkOne(client, kind, sourceId, row);
      if (r === 'no_contact') return { outcome: 'no_contact' };
      return { outcome: 'linked', partnerId: row.partner_id, ...r };
    } catch (err) {
      if (sqlstate(err) === '23505' && attempt === 0) continue;
      console.error('[crm] контакт не привязан:', kind, 'SQLSTATE', sqlstate(err));
      return { outcome: 'failed', reason: `link ${sqlstate(err)}` };
    } finally {
      client.release();
    }
  }
}

/**
 * Хук на создание источника: привязать и ни в коем случае не уронить того,
 * кто его позвал. Бронь важнее CRM — отказ пишется в лог с видом источника и
 * SQLSTATE, без ПД; пропущенное подберёт задел `GET /api/cron/crm-contacts-sync`.
 */
export async function linkContactQuietly(
  kind: SourceKind,
  sourceId: string | number | bigint | null | undefined,
  db: CrmDb = pool,
): Promise<void> {
  if (sourceId === null || sourceId === undefined) return;
  try {
    const r = await linkContactFromSource(kind, String(sourceId), db);
    if (r.outcome === 'bad_id') console.error('[crm] хук: id источника не того вида:', kind);
  } catch (err) {
    console.error('[crm] хук упал:', kind, 'SQLSTATE', sqlstate(err));
  }
}
