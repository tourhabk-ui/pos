/**
 * Выезды для «Регистрации в МЧС» кабинета в чате (10.11) — чтение из базы.
 *
 * Чьи брони видит карточка — одно правило на список и на выезд:
 *  - свои туры (`operator_tours.operator_id` — оператор и гид с авторскими турами);
 *  - брони, назначенные гиду оператором его действующей команды
 *    (`guide_partner_id` и `partners.guide_operator_id`, как TEAM_SQL.assignedUpcoming).
 *
 * Выезд — подтверждённые брони (`confirmed`, `pending_payment`), как «Выезды»
 * экрана «Сегодня» (lib/operators/live-seats): неподтверждённая бронь — ещё не
 * группа. Список — без имён. Имя и телефон контактного лица брони выбираются
 * ТОЛЬКО по `withContacts` (MAX): чего не выбрали, то в Telegram не утечёт
 * при следующей правке экрана (pd-guard, §2).
 *
 * Отказ базы — `'failed'` и строка в лог с SQLSTATE, не пустой список (§4.0).
 */

import { pool } from '@/lib/db-pool';
import type { MchsBookingContact, MchsDeparture, MchsGroup } from '@/lib/safety/mchs-chat';

interface Queryable {
  query: typeof pool.query;
}

/** `b` — operator_bookings, `t` — operator_tours; $1 — partners.id карточки. */
const OWN_OR_ASSIGNED = `
  (t.operator_id = $1::uuid
   OR (b.guide_partner_id = $1::uuid
       AND EXISTS (SELECT 1 FROM partners g WHERE g.id = b.guide_partner_id AND g.guide_operator_id = t.operator_id)))`;

const DEPARTURE = `
  b.deleted_at IS NULL AND t.deleted_at IS NULL
  AND b.booking_status IN ('confirmed', 'pending_payment')`;

export const MCHS_DEPARTURES_SQL = `
  SELECT b.booking_date::text AS d,
         MAX(COALESCE(b.end_date, b.booking_date))::text AS end_d,
         t.id::text AS tour_id, t.title,
         COALESCE(SUM(b.participants), 0)::int AS people, COUNT(*)::int AS n,
         r.title AS route_title, r.mchs_registration_required AS required, r.mchs_phone
    FROM operator_bookings b
    JOIN operator_tours t ON t.id = b.operator_tour_id
    LEFT JOIN kamchatka_routes r ON r.id = t.route_id
   WHERE ${DEPARTURE}
     AND b.booking_date >= $2::date AND b.booking_date <= $3::date
     AND ${OWN_OR_ASSIGNED}
   GROUP BY b.booking_date, t.id, t.title, r.title, r.mchs_registration_required, r.mchs_phone
   ORDER BY b.booking_date, t.title, t.id
   LIMIT 60`;

/** Брони выезда. Контакты — отдельным списком колонок: без флага их в запросе нет. */
export function mchsGroupSql(withContacts: boolean): string {
  const contact = withContacts ? 'b.tourist_name, b.tourist_phone,' : '';
  return `
  SELECT ${contact}
         b.participants,
         COALESCE(b.end_date, b.booking_date)::text AS end_d,
         t.title, r.title AS route_title, r.mchs_registration_required AS required, r.mchs_phone
    FROM operator_bookings b
    JOIN operator_tours t ON t.id = b.operator_tour_id
    LEFT JOIN kamchatka_routes r ON r.id = t.route_id
   WHERE ${DEPARTURE}
     AND t.id = $2::bigint AND b.booking_date = $3::date
     AND ${OWN_OR_ASSIGNED}
   ORDER BY b.created_at, b.id
   LIMIT 60`;
}

function logFail(what: string, err: unknown): void {
  console.error(`[chat-cabinet/mchs] ${what} — отказ, SQLSTATE ${(err as { code?: string } | null)?.code ?? 'нет SQLSTATE'}`);
}

interface DepartureRow {
  d: string; end_d: string; tour_id: string; title: string; people: number | string; n: number | string;
  route_title: string | null; required: boolean | null; mchs_phone: string | null;
}

/** Выезды карточки с `from` по `to` (YYYY-MM-DD, по Камчатке), без имён. */
export async function loadMchsDepartures(
  partnerId: string, from: string, to: string, db: Queryable = pool,
): Promise<MchsDeparture[] | 'failed'> {
  try {
    const { rows } = await db.query<DepartureRow>(MCHS_DEPARTURES_SQL, [partnerId, from, to]);
    return rows.map((r) => ({
      date: r.d.slice(0, 10), endDate: r.end_d.slice(0, 10), tourId: r.tour_id, title: r.title,
      people: Number(r.people), bookings: Number(r.n),
      routeTitle: r.route_title, required: r.required, mchsPhone: r.mchs_phone,
    }));
  } catch (err) {
    logFail('выезды', err);
    return 'failed';
  }
}

interface GroupRow {
  tourist_name?: string | null; tourist_phone?: string | null;
  participants: number | string; end_d: string; title: string;
  route_title: string | null; required: boolean | null; mchs_phone: string | null;
}

/** Выезд тура на дату. null — броней нет (или тур и бронь не этой карточки). */
export async function loadMchsGroup(
  partnerId: string, tourId: string, date: string, withContacts: boolean, db: Queryable = pool,
): Promise<MchsGroup | null | 'failed'> {
  try {
    const { rows } = await db.query<GroupRow>(mchsGroupSql(withContacts), [partnerId, tourId, date]);
    const first = rows[0];
    if (!first) return null;
    const contacts: MchsBookingContact[] | null = withContacts
      ? rows.map((r) => ({ name: r.tourist_name ?? null, phone: r.tourist_phone ?? null, participants: Number(r.participants) || 0 }))
      : null;
    const endDate = rows.reduce((max, r) => (r.end_d.slice(0, 10) > max ? r.end_d.slice(0, 10) : max), date);
    return {
      date, endDate, tourId, title: first.title,
      people: rows.reduce((sum, r) => sum + (Number(r.participants) || 0), 0), bookings: rows.length,
      routeTitle: first.route_title, required: first.required, mchsPhone: first.mchs_phone,
      contacts,
    };
  } catch (err) {
    logFail('выезд', err);
    return 'failed';
  }
}
