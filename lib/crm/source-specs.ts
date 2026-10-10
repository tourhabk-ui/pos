/**
 * lib/crm/source-specs.ts — шесть источников клиента партнёра как SQL-текст:
 * откуда берётся человек, какая строка годна в клиента, условие «ещё не
 * привязана» (CRM фаза 1, #2325).
 *
 * Отдельный модуль без пула и без записи — чтобы переписи, которые обещают
 * показать ровно то, что видит задел (`bookings-origin-census`), брали
 * условие отсюда, а не держали копию, и при этом не наследовали в реестре
 * возможностей «пишет в базу» от писателя клиентов (`lib/crm/contacts`).
 * Копия условия в переписи разошлась с заделом в первый же день (#2337).
 */
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
  // сказать нечего, как в «Бронированиях» оператора.
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
