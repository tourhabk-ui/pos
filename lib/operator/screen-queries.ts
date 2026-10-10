/**
 * SQL четырёх экранов кабинета оператора — в одном месте, чтобы его
 * можно было ПРОГНАТЬ на настоящем PostgreSQL.
 *
 * Прогулка оператором 10.09 (#1794): «Полнота туров», «Клиенты»,
 * «Аналитика» и «Гиды» отвечали 500 на любой запрос — колонки
 * `ot.transportation`, `tp.amount`, `g.specializations` не существуют,
 * а алиас CTE `cs` использовался внутри собственного определения. Юнит-моки
 * отвечают `{rowCount: 0}` на любой текст и такого не видят; форму SQL
 * доказывает только сервер (§4.0 «судить статикой запрещено»). Отсюда
 * правило файла: запрос живёт здесь, роут его импортирует, а
 * `tests/integration/operator-screens.pg.test.ts` исполняет каждый на
 * базе из baseline + миграций.
 */

// ─── Полнота туров ────────────────────────────────────────────────────────────

/** $1 — partners.id оператора. Без `transportation`: такой колонки в operator_tours нет. */
export const COMPLETENESS_TOURS_SQL = `
  SELECT
    ot.id, ot.title, ot.description, ot.short_description,
    ot.base_price, ot.max_participants, ot.min_participants,
    ot.location_type, ot.activity_type, ot.location_name,
    ot.latitude, ot.longitude, ot.duration_hours, ot.difficulty,
    ot.season_start, ot.season_end, ot.duration_type,
    ot.included, ot.not_included, ot.what_to_bring,
    ot.tour_image, ot.photos, ot.price_old, ot.price_unit,
    ot.is_published,
    -- Витринная готовность: те же поля, по которым судят ленты каналов.
    ot.pickup_type,
    COALESCE(LENGTH(TRIM(ot.pickup_details)), 0) AS pickup_details_chars,
    (ot.meeting_point IS NOT NULL AND LENGTH(TRIM(ot.meeting_point)) > 0) AS has_meeting_point,
    (ot.cancellation_policy IS NOT NULL AND LENGTH(TRIM(ot.cancellation_policy)) > 0) AS has_cancellation_policy,
    (p.contacts IS NOT NULL AND p.contacts::text <> '{}') AS has_operator_contact
  FROM operator_tours ot
  LEFT JOIN partners p ON p.id = ot.operator_id
  WHERE ot.operator_id = $1 AND ot.deleted_at IS NULL
  ORDER BY ot.created_at DESC`;

// ─── Аналитика ────────────────────────────────────────────────────────────────

/**
 * Все пять запросов: $1 — partners.id, $2 — начало периода (timestamptz).
 *
 * Выручка — `tour_payments.retail_amount`: то, что заплатил турист. Колонки
 * `amount` в таблице нет (есть retail / net / commission); `net_amount` —
 * это к выплате оператору, и он живёт на экране «Финансы», а не здесь.
 */
export const ANALYTICS_SQL = {
  revenueByMonth: `
    SELECT
      DATE_TRUNC('month', tp.paid_at)::date AS month,
      SUM(tp.retail_amount) AS total_revenue,
      COUNT(DISTINCT ob.id) AS booking_count
    FROM tour_payments tp
    JOIN operator_bookings ob ON ob.id = tp.booking_id
    JOIN operator_tours ot ON ot.id = ob.operator_tour_id
    WHERE ot.operator_id = $1 AND tp.paid_at >= $2 AND tp.status = 'RELEASED'
      AND ob.deleted_at IS NULL
    GROUP BY DATE_TRUNC('month', tp.paid_at)
    ORDER BY month DESC`,
  topTours: `
    SELECT
      ot.id AS tour_id,
      ot.title AS tour_title,
      COUNT(ob.id) AS booking_count,
      COALESCE(SUM(tp.retail_amount), 0) AS total_revenue,
      COALESCE(AVG(ob.final_price), 0) AS avg_price
    FROM operator_tours ot
    LEFT JOIN operator_bookings ob ON ob.operator_tour_id = ot.id
      AND ob.created_at >= $2 AND ob.deleted_at IS NULL
    LEFT JOIN tour_payments tp ON tp.booking_id = ob.id
      AND tp.status = 'RELEASED'
    WHERE ot.operator_id = $1 AND ot.deleted_at IS NULL
    GROUP BY ot.id, ot.title
    ORDER BY booking_count DESC
    LIMIT 10`,
  conversion: `
    WITH views AS (
      SELECT COUNT(*)::int AS n FROM page_views pv
      JOIN operator_tours ot ON pv.path LIKE '%/routes/' || ot.agent_route_id || '%'
      WHERE ot.operator_id = $1 AND pv.created_at >= $2
    ),
    bookings AS (
      SELECT COUNT(*)::int AS n FROM operator_bookings ob
      JOIN operator_tours ot ON ot.id = ob.operator_tour_id
      WHERE ot.operator_id = $1 AND ob.created_at >= $2 AND ob.deleted_at IS NULL
    )
    SELECT
      views.n AS total_page_views,
      bookings.n AS total_bookings,
      CASE WHEN views.n > 0 THEN ROUND(bookings.n::numeric / views.n::numeric * 100, 2) ELSE 0 END AS conversion_rate
    FROM views, bookings`,
  statusBreakdown: `
    SELECT ob.booking_status AS status, COUNT(*) AS count
    FROM operator_bookings ob
    JOIN operator_tours ot ON ot.id = ob.operator_tour_id
    WHERE ot.operator_id = $1 AND ob.created_at >= $2 AND ob.deleted_at IS NULL
    GROUP BY ob.booking_status`,
  summary: `
    SELECT
      COALESCE(SUM(tp.retail_amount), 0) AS total_revenue,
      COUNT(DISTINCT ob.id) AS total_bookings,
      COALESCE(AVG(ob.final_price), 0) AS avg_booking_value,
      (SELECT COUNT(*) FROM operator_bookings ob2
       JOIN operator_tours ot2 ON ot2.id = ob2.operator_tour_id
       WHERE ot2.operator_id = $1 AND ob2.booking_status = 'completed'
         AND ob2.created_at >= $2 AND ob2.deleted_at IS NULL) AS completed_bookings
    FROM operator_bookings ob
    JOIN operator_tours ot ON ot.id = ob.operator_tour_id
    LEFT JOIN tour_payments tp ON tp.booking_id = ob.id AND tp.status = 'RELEASED'
    WHERE ot.operator_id = $1 AND ob.created_at >= $2 AND ob.deleted_at IS NULL`,
} as const;

// ─── Гиды ─────────────────────────────────────────────────────────────────────

/**
 * $1 — partners.id оператора. Колонки `specializations` у partners нет и не
 * было; вместо неё — подтверждённые аттестации из `guide_certifications`
 * (у них есть производитель: кабинет гида).
 *
 * `tours_count` — назначения гида на живые брони ЭТОГО оператора
 * (operator_bookings.guide_partner_id, миграция 1018). До 25.09 здесь
 * считались записи личного календаря гида (guide_schedule) — у любых
 * операторов и вперемешку с личными делами, а подписывались «выходами».
 * Членство — partners.guide_operator_id; пишет его только принятие
 * приглашения (/api/guide/team).
 */
export const GUIDES_SQL = `
  SELECT
    g.id,
    g.name,
    g.rating,
    g.is_available,
    (SELECT COUNT(*)
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
      WHERE ob.guide_partner_id = g.id
        AND ot.operator_id = $1
        AND ob.deleted_at IS NULL
        AND ob.booking_status NOT IN ('cancelled', 'rejected', 'no_show'))::text AS tours_count,
    (SELECT COUNT(*) FROM guide_certifications gc
      WHERE gc.guide_id = g.id AND gc.is_verified)::text AS verified_certifications
  FROM partners g
  WHERE g.category = 'guide' AND g.guide_operator_id = $1
  ORDER BY g.name NULLS LAST`;

/** Отказ запроса пишется с именем экрана и SQLSTATE — «не смог» не выдаётся за «пусто» (§4.0). */
export function logScreenQueryFailure(screen: string, error: unknown): void {
  const e = error as { code?: string; message?: string } | null;
  console.error(`[operator/${screen}] запрос не выполнен:`, `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(error));
}
