/**
 * Загрузка мест по броням на даты поездки — данные для flow-balance.
 *
 * Спрос считается по `operator_bookings`: бронь тура раскладывается по
 * дням (booking_date … end_date, как в v_tour_daily_occupancy) и по местам
 * маршрута тура (operator_tours.route_id → route_waypoints → places). Связи
 * рода `nearby` не считаются: «рядом, загляните» — не место, куда группа
 * идёт (§4.1, миграция 874).
 *
 * Учитываются брони, кроме отменённых и неявок, — включая неоплаченные:
 * человек, ждущий оплаты, в этот день туда собирается. Многодневный тур
 * засчитывается всем своим местам на каждый свой день: по какому дню
 * какое место, в данных не записано, и оценка намеренно сверху — лишний
 * раз предупредить дешевле, чем пустить сверх нормы.
 *
 * Сохранённые планы (`user_trips`) не считаются: у дней там нет ни мест,
 * ни обязательства поехать. Когда появятся — это второй производитель.
 *
 * `null` на выходе — спросить не вышло; причина в логе. Это «не знаем», и
 * вызывающий обязан не судить, а не считать нулём (§4.0).
 */
import { pool } from '@/lib/db-pool';
import { CANCELLED_BOOKING_STATUSES } from '@/lib/payments/release-eligibility';
import type { PlaceLoad } from '@/lib/planner/flow-balance';

/** Брони, которые в место не едут. */
export const NOT_TRAVELLING_STATUSES: string[] = [...CANCELLED_BOOKING_STATUSES, 'no_show'];

/** Спрос по местам на окно дат: самые загруженные сутки каждого места. */
const DEMAND_CTE = `
  demand AS (
    SELECT rw.place_id, d.day::date AS date, SUM(b.participants)::int AS people
      FROM operator_bookings b
      JOIN operator_tours t ON t.id = b.operator_tour_id
      JOIN route_waypoints rw
        ON rw.route_id = t.route_id AND COALESCE(rw.link_kind, 'unknown') <> 'nearby'
      CROSS JOIN LATERAL generate_series(
        b.booking_date::timestamp,
        COALESCE(b.end_date, b.booking_date)::timestamp,
        interval '1 day'
      ) AS d(day)
     WHERE b.deleted_at IS NULL
       AND NOT (b.booking_status = ANY($4::text[]))
       AND d.day::date BETWEEN $2::date AND $3::date
       AND rw.place_id IN (SELECT place_id FROM cand)
     GROUP BY rw.place_id, d.day::date
  )`;

const SELECT_LOADS = `
  SELECT cand.cid, cand.place_id, cand.name,
         cand.visitor_limit_per_day AS limit_per_day,
         cand.visitor_limit_source AS limit_source,
         COALESCE((SELECT MAX(people) FROM demand WHERE demand.place_id = cand.place_id), 0)::int AS planned
    FROM cand`;

/**
 * Кандидаты самостоятельного дня — id из выдачи планировщика: у места это
 * places.ark_id, у маршрута — COALESCE(ark_id, id) (так их отдаёт
 * agent_route_knowledge, миграция 942). Маршрут раскрывается в свои места.
 */
const CANDIDATE_LOADS_SQL = `
  WITH cand AS (
    SELECT c.cid, p.id AS place_id, p.name, p.visitor_limit_per_day, p.visitor_limit_source
      FROM unnest($1::text[]) AS c(cid)
      JOIN places p ON p.ark_id::text = c.cid
    UNION
    SELECT c.cid, p.id, p.name, p.visitor_limit_per_day, p.visitor_limit_source
      FROM unnest($1::text[]) AS c(cid)
      JOIN kamchatka_routes r ON COALESCE(r.ark_id, r.id)::text = c.cid
      JOIN route_waypoints rw
        ON rw.route_id = r.id AND COALESCE(rw.link_kind, 'unknown') <> 'nearby'
      JOIN places p ON p.id = rw.place_id
  ),${DEMAND_CTE}
  ${SELECT_LOADS}`;

/** Туры — места их маршрута. Тур без маршрута мест не имеет, и судить нечего. */
const TOUR_LOADS_SQL = `
  WITH cand AS (
    SELECT c.cid, p.id AS place_id, p.name, p.visitor_limit_per_day, p.visitor_limit_source
      FROM unnest($1::text[]) AS c(cid)
      JOIN operator_tours t ON t.id::text = c.cid
      JOIN route_waypoints rw
        ON rw.route_id = t.route_id AND COALESCE(rw.link_kind, 'unknown') <> 'nearby'
      JOIN places p ON p.id = rw.place_id
  ),${DEMAND_CTE}
  ${SELECT_LOADS}`;

interface LoadRow {
  cid: string;
  place_id: string;
  name: string;
  limit_per_day: number | null;
  limit_source: string | null;
  planned: number;
}

async function loads(sql: string, what: string, ids: string[], from: string, to: string): Promise<Map<string, PlaceLoad[]> | null> {
  const out = new Map<string, PlaceLoad[]>();
  if (ids.length === 0) return out;
  try {
    const { rows } = await pool.query<LoadRow>(sql, [ids, from, to, NOT_TRAVELLING_STATUSES]);
    for (const r of rows) {
      const list = out.get(r.cid) ?? [];
      list.push({
        placeId: r.place_id,
        name: r.name,
        planned: r.planned,
        limit: r.limit_per_day,
        limitSource: r.limit_source,
      });
      out.set(r.cid, list);
    }
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string } | null)?.code ?? '-';
    console.error(`[planner] загрузка мест не посчиталась (${what}, ${from}..${to}, SQLSTATE ${code}):`, message);
    return null;
  }
}

export function fetchCandidateLoads(ids: string[], from: string, to: string) {
  return loads(CANDIDATE_LOADS_SQL, 'кандидаты', ids, from, to);
}

export function fetchTourLoads(tourIds: string[], from: string, to: string) {
  return loads(TOUR_LOADS_SQL, 'туры', tourIds, from, to);
}
