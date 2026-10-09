/**
 * lib/analytics/bookings-origin.ts — откуда взялись брони тура за окно
 * времени: кем созданы (`created_via`), в каком статусе, по какому туру и
 * оператору, есть ли у них контакт туриста — БЕЗ самих контактов.
 *
 * ── Повод (09.10) ─────────────────────────────────────────────────────────
 *
 * Задел клиентов CRM (prod-check run 100) показал 1 → 2 → 2: пока шли три
 * вызова подряд, на проде появились две новые `operator_bookings` — за одну
 * минуту, около 23:15 по Камчатке. Владелец их не создавал и в админке не
 * видит. Ни одна перепись не могла сказать, что это за строки: воронка
 * считает брони числом, админ-список требует JWT и показывает человеку, а
 * не раннеру. Отсюда перепись, которая называет ПРОИСХОЖДЕНИЕ каждой
 * недавней брони, не называя человека.
 *
 * ── Что здесь нет по построению ───────────────────────────────────────────
 *
 * Имя, телефон и почта туриста участвуют только в виде «есть / нет»
 * (`NULLIF(btrim(…), '') IS NOT NULL`); `metadata` — только именами ключей.
 * Сторож `tests/unit/bookings-origin-census.test.ts` это держит.
 *
 * Третье состояние (§4.0): каждый запрос отвечает строками ИЛИ попадает в
 * `failed` с SQLSTATE; «ноль броней» и «запрос упал» — разные вещи.
 */
import { pool } from '@/lib/db-pool';
import { UNLINKED_WHERE } from '@/lib/crm/source-specs';

export const DEFAULT_HOURS = 48;
export const MAX_HOURS = 24 * 30;
export const RECENT_LIMIT = 100;

/**
 * Область переписи: `window` — брони, созданные за окно часов; `unlinked` —
 * брони без клиента CRM, ровно по предикату задела (`crm-contacts-sync`:
 * не удалена, у тура есть оператор, связи нет), без ограничения по времени.
 * Вторая нужна, когда задел видит строки, которых в окне нет: run 103
 * (09.10) показал ноль броней за 30 суток при одной непривязанной.
 */
export const CENSUS_SCOPES = ['window', 'unlinked'] as const;
export type CensusScope = (typeof CENSUS_SCOPES)[number];

export function parseScope(raw: string | null | undefined): CensusScope {
  return raw === 'unlinked' ? 'unlinked' : 'window';
}

/** Окно в часах: 1…720; мусор → умолчание. */
export function clampHours(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === '') return DEFAULT_HOURS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_HOURS;
  return Math.min(MAX_HOURS, Math.max(1, Math.trunc(n)));
}

/** Присутствие контакта — факт о строке, не сам контакт. */
const HAS_PHONE = `(NULLIF(btrim(b.tourist_phone), '') IS NOT NULL)`;
const HAS_EMAIL = `(NULLIF(btrim(b.tourist_email), '') IS NOT NULL)`;
const HAS_NAME = `(NULLIF(btrim(b.tourist_name), '') IS NOT NULL)`;

const RECENT_SELECT = `
  SELECT b.id::text AS id,
         b.created_at::text AS created_at,
         b.created_via,
         b.booking_status,
         b.payment_status,
         b.booking_date::text AS booking_date,
         b.participants,
         b.operator_tour_id::text AS operator_tour_id,
         t.title AS tour_title,
         t.is_active AS tour_active,
         p.name AS operator_name,
         (b.user_id IS NOT NULL) AS has_user,
         ${HAS_PHONE} AS has_phone,
         ${HAS_EMAIL} AS has_email,
         ${HAS_NAME} AS has_name,
         (b.octo_api_key_id IS NOT NULL) AS via_octo,
         (b.agent_user_id IS NOT NULL) AS via_agent,
         (b.referral_link_id IS NOT NULL) AS via_referral,
         (b.hold_expires_at IS NOT NULL) AS has_hold,
         (b.deleted_at IS NOT NULL) AS deleted,
         COALESCE((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(COALESCE(b.metadata, '{}'::jsonb)) AS k), '{}') AS metadata_keys,
         EXISTS (SELECT 1 FROM crm_contact_links l
                  WHERE l.source_kind = 'operator_booking' AND l.source_id = b.id::text) AS crm_linked
    FROM operator_bookings b
    LEFT JOIN operator_tours t ON t.id = b.operator_tour_id
    LEFT JOIN partners p ON p.id = t.operator_id`;

/**
 * Предикат задела клиентов — не копия, а тот же текст из lib/crm/source-specs:
 * там строка брони зовётся `s`, здесь `b`. Копия разошлась с заделом в
 * первый же день (служебная бронь, #2337), поэтому условие берётся оттуда.
 */
const UNLINKED_ELIGIBLE = UNLINKED_WHERE.operator_booking.replace(/\bs\./g, 'b.');

export const RECENT_SQL = `${RECENT_SELECT}
   WHERE b.created_at >= NOW() - make_interval(hours => $1::int)
   ORDER BY b.created_at DESC
   LIMIT $2::int`;

/** $1 — лимит. Непривязанные к CRM, без окна времени. */
export const RECENT_UNLINKED_SQL = `${RECENT_SELECT}
   WHERE ${UNLINKED_ELIGIBLE}
   ORDER BY b.created_at DESC
   LIMIT $1::int`;

const BY_ORIGIN_SELECT = `
  SELECT COALESCE(b.created_via, '(не записано)') AS created_via,
         COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE b.user_id IS NULL AND NOT ${HAS_PHONE} AND NOT ${HAS_EMAIL})::int AS without_contact,
         COUNT(*) FILTER (WHERE b.deleted_at IS NOT NULL)::int AS deleted
    FROM operator_bookings b
    LEFT JOIN operator_tours t ON t.id = b.operator_tour_id`;

export const BY_ORIGIN_SQL = `${BY_ORIGIN_SELECT}
   WHERE b.created_at >= NOW() - make_interval(hours => $1::int)
   GROUP BY 1
   ORDER BY n DESC`;

/** Без параметров: сводка непривязанных к CRM по created_via. */
export const BY_ORIGIN_UNLINKED_SQL = `${BY_ORIGIN_SELECT}
   WHERE ${UNLINKED_ELIGIBLE}
   GROUP BY 1
   ORDER BY n DESC`;

export interface RecentBookingRow {
  id: string;
  created_at: string;
  created_via: string | null;
  booking_status: string;
  payment_status: string;
  booking_date: string;
  participants: number;
  operator_tour_id: string;
  tour_title: string | null;
  tour_active: boolean | null;
  operator_name: string | null;
  has_user: boolean;
  has_phone: boolean;
  has_email: boolean;
  has_name: boolean;
  via_octo: boolean;
  via_agent: boolean;
  via_referral: boolean;
  has_hold: boolean;
  deleted: boolean;
  metadata_keys: string[];
  crm_linked: boolean;
}

export interface OriginRow { created_via: string; n: number; without_contact: number; deleted: number }

export interface BookingsOriginReport {
  scope: CensusScope;
  /** Для scope=window — окно в часах; для unlinked — null: окна нет. */
  hours: number | null;
  /** created_at — как хранится (timestamp без пояса, сессия БД). */
  created_at_note: string;
  recent: RecentBookingRow[] | null;
  recent_truncated: boolean;
  by_origin: OriginRow[] | null;
  by_origin_30d: OriginRow[] | null;
  failed: Array<{ measure: string; sqlstate: string }>;
}

interface Exec { query: typeof pool.query }

function sqlstate(err: unknown): string {
  return (err as { code?: string })?.code ?? 'нет SQLSTATE';
}

export async function censusBookingsOrigin(
  hours: number,
  exec: Exec = pool,
  scope: CensusScope = 'window',
): Promise<BookingsOriginReport> {
  const failed: BookingsOriginReport['failed'] = [];
  const run = async <T>(measure: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      console.error(`[bookings-origin-census] ${measure} не выполнен, SQLSTATE ${sqlstate(err)}`);
      failed.push({ measure, sqlstate: sqlstate(err) });
      return null;
    }
  };
  const unlinked = scope === 'unlinked';
  const [recent, byOrigin, byOrigin30d] = await Promise.all([
    run('recent', async () => (unlinked
      ? await exec.query<RecentBookingRow>(RECENT_UNLINKED_SQL, [RECENT_LIMIT + 1])
      : await exec.query<RecentBookingRow>(RECENT_SQL, [hours, RECENT_LIMIT + 1])).rows),
    run('by_origin', async () => (unlinked
      ? await exec.query<OriginRow>(BY_ORIGIN_UNLINKED_SQL)
      : await exec.query<OriginRow>(BY_ORIGIN_SQL, [hours])).rows),
    run('by_origin_30d', async () => (await exec.query<OriginRow>(BY_ORIGIN_SQL, [MAX_HOURS])).rows),
  ]);
  return {
    scope,
    hours: unlinked ? null : hours,
    created_at_note: 'created_at — как хранится в operator_bookings (timestamp без пояса, сессия БД)',
    recent: recent ? recent.slice(0, RECENT_LIMIT) : null,
    recent_truncated: (recent?.length ?? 0) > RECENT_LIMIT,
    by_origin: byOrigin,
    by_origin_30d: byOrigin30d,
    failed,
  };
}
