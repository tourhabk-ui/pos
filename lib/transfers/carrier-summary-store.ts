/**
 * Сводка перевозчика — чтение базы (#2862 этап D). Три запроса, три исхода:
 * каждый блок читается отдельно, и отказ одного не глушит остальные (null
 * блок — «не прочиталось», с SQLSTATE в логе).
 *
 * Источники те же, что у «Входящих» и отзывов:
 *   · заявки — leads с source_data.kind = 'charter' перевозчика, не свои;
 *     ответ — lead_activity_log.partner_answered (details.at — ISO строка,
 *     как в inbox-sql), «ждут ответа» — тем же правилом, что ящик: без ответа,
 *     статус ожидания, дата выезда не прошла;
 *   · поездки — lead_activity_log.ride_outcome (details.outcome held /
 *     not_held) за окно; «ждут» — заявки с «Беру», у которых поездка кончилась
 *     и исхода нет (как вид charter_ride «Входящих», без двухчасового порога);
 *   · отзывы — carrier_reviews видимые, средняя считается при чтении (§14:
 *     хранимого рейтинга нет).
 */

import { pool } from '@/lib/db-pool';
import { LEAD_WAITING_STATUSES } from '@/lib/leads/owner-lead-words';
import {
  SUMMARY_WINDOW_DAYS, medianOf,
  type CarrierSummary, type CharterRequestsSummary, type ReviewsSummary, type RidesSummary,
} from '@/lib/transfers/carrier-summary';

function sqlState(err: unknown): string {
  return (err as { code?: string }).code ?? 'нет';
}

const WAITING = `(${LEAD_WAITING_STATUSES.map((s) => `'${s}'`).join(', ')})`;

const REQUESTS_SQL = `
  SELECT l.created_at,
         pa.answered_at,
         (pa.answered_at IS NULL AND lm.first_at IS NULL
           AND l.status IN ${WAITING}
           AND COALESCE(
             CASE WHEN l.source_data->>'date_from' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                  THEN (l.source_data->>'date_from')::date >= (NOW() AT TIME ZONE 'Asia/Kamchatka')::date END,
             TRUE)) AS waiting
    FROM leads l
    CROSS JOIN LATERAL (
      SELECT min(CASE WHEN a.details->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}' THEN (a.details->>'at')::timestamptz END) AS answered_at
        FROM lead_activity_log a
       WHERE a.lead_id = l.id AND a.action = 'partner_answered'
    ) pa
    CROSS JOIN LATERAL (
      SELECT min(m.created_at) AS first_at FROM request_messages m
       WHERE m.lead_id = l.id AND m.author = 'owner'
    ) lm
   WHERE l.operator_id = $1::uuid AND l.is_self = FALSE
     AND l.source_data->>'kind' = 'charter'
     AND l.created_at >= NOW() - make_interval(days => $2::int)`;

const RIDES_SQL = `
  SELECT
    count(*) FILTER (WHERE o.outcome = 'held')::int AS held,
    count(*) FILTER (WHERE o.outcome = 'not_held')::int AS not_held
    FROM (
      SELECT a.details->>'outcome' AS outcome
        FROM lead_activity_log a
        JOIN leads l ON l.id = a.lead_id
       WHERE l.operator_id = $1::uuid AND l.source_data->>'kind' = 'charter'
         AND a.action = 'ride_outcome'
         AND a.created_at >= NOW() - make_interval(days => $2::int)
    ) o`;

/** Заявки с «Беру», поездка кончилась по Камчатке, исхода нет. */
const RIDES_AWAITING_SQL = `
  SELECT count(*)::int AS awaiting
    FROM leads l
   WHERE l.operator_id = $1::uuid AND l.is_self = FALSE
     AND l.source_data->>'kind' = 'charter'
     AND EXISTS (SELECT 1 FROM lead_activity_log a
                  WHERE a.lead_id = l.id AND a.action = 'partner_answered' AND a.details->>'answer' = 'take')
     AND NOT EXISTS (SELECT 1 FROM lead_activity_log a WHERE a.lead_id = l.id AND a.action = 'ride_outcome')
     AND COALESCE(NULLIF(l.source_data->>'date_to', ''), l.source_data->>'date_from') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     AND COALESCE(NULLIF(l.source_data->>'date_to', ''), l.source_data->>'date_from')::date < (NOW() AT TIME ZONE 'Asia/Kamchatka')::date`;

const REVIEWS_SQL = `
  SELECT count(*)::int AS visible, avg(rating)::float AS average
    FROM carrier_reviews
   WHERE partner_id = $1::uuid AND NOT is_hidden`;

async function readRequests(partnerId: string, days: number): Promise<CharterRequestsSummary | null> {
  try {
    const { rows } = await pool.query<{ created_at: Date; answered_at: Date | null; waiting: boolean }>(REQUESTS_SQL, [partnerId, days]);
    const minutes = rows
      .filter((r) => r.answered_at !== null)
      .map((r) => Math.max(0, (new Date(r.answered_at as Date).getTime() - new Date(r.created_at).getTime()) / 60_000));
    const median = medianOf(minutes);
    return {
      total: rows.length,
      answered: minutes.length,
      waiting: rows.filter((r) => r.waiting === true).length,
      medianMinutes: median === null ? null : Math.round(median),
    };
  } catch (err) {
    console.error('[carrier-summary] заявки не прочитаны, SQLSTATE', sqlState(err));
    return null;
  }
}

async function readRides(partnerId: string, days: number): Promise<RidesSummary | null> {
  try {
    const [outcomes, awaiting] = await Promise.all([
      pool.query<{ held: number; not_held: number }>(RIDES_SQL, [partnerId, days]),
      pool.query<{ awaiting: number }>(RIDES_AWAITING_SQL, [partnerId]),
    ]);
    return {
      held: outcomes.rows[0]?.held ?? 0,
      notHeld: outcomes.rows[0]?.not_held ?? 0,
      awaiting: awaiting.rows[0]?.awaiting ?? 0,
    };
  } catch (err) {
    console.error('[carrier-summary] поездки не прочитаны, SQLSTATE', sqlState(err));
    return null;
  }
}

async function readReviews(partnerId: string): Promise<ReviewsSummary | null> {
  try {
    const { rows } = await pool.query<{ visible: number; average: number | null }>(REVIEWS_SQL, [partnerId]);
    const visible = rows[0]?.visible ?? 0;
    const avg = rows[0]?.average;
    return { visible, average: visible > 0 && avg !== null && avg !== undefined ? Math.round(avg * 10) / 10 : null };
  } catch (err) {
    console.error('[carrier-summary] отзывы не прочитаны, SQLSTATE', sqlState(err));
    return null;
  }
}

export async function loadCarrierSummary(partnerId: string, days: number = SUMMARY_WINDOW_DAYS): Promise<CarrierSummary> {
  const [requests, rides, reviews] = await Promise.all([
    readRequests(partnerId, days),
    readRides(partnerId, days),
    readReviews(partnerId),
  ]);
  return { windowDays: days, requests, rides, reviews };
}
