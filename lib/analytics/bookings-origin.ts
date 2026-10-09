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

export const DEFAULT_HOURS = 48;
export const MAX_HOURS = 24 * 30;
export const RECENT_LIMIT = 100;

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

export const RECENT_SQL = `
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
    LEFT JOIN partners p ON p.id = t.operator_id
   WHERE b.created_at >= NOW() - make_interval(hours => $1::int)
   ORDER BY b.created_at DESC
   LIMIT $2::int`;

export const BY_ORIGIN_SQL = `
  SELECT COALESCE(b.created_via, '(не записано)') AS created_via,
         COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE b.user_id IS NULL AND NOT ${HAS_PHONE} AND NOT ${HAS_EMAIL})::int AS without_contact,
         COUNT(*) FILTER (WHERE b.deleted_at IS NOT NULL)::int AS deleted
    FROM operator_bookings b
   WHERE b.created_at >= NOW() - make_interval(hours => $1::int)
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
  hours: number;
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

export async function censusBookingsOrigin(hours: number, exec: Exec = pool): Promise<BookingsOriginReport> {
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
  const [recent, byOrigin, byOrigin30d] = await Promise.all([
    run('recent', async () => (await exec.query<RecentBookingRow>(RECENT_SQL, [hours, RECENT_LIMIT + 1])).rows),
    run('by_origin', async () => (await exec.query<OriginRow>(BY_ORIGIN_SQL, [hours])).rows),
    run('by_origin_30d', async () => (await exec.query<OriginRow>(BY_ORIGIN_SQL, [MAX_HOURS])).rows),
  ]);
  return {
    hours,
    created_at_note: 'created_at — как хранится в operator_bookings (timestamp без пояса, сессия БД)',
    recent: recent ? recent.slice(0, RECENT_LIMIT) : null,
    recent_truncated: (recent?.length ?? 0) > RECENT_LIMIT,
    by_origin: byOrigin,
    by_origin_30d: byOrigin30d,
    failed,
  };
}
