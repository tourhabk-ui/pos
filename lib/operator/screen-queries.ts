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

// ─── Клиенты (CRM) ────────────────────────────────────────────────────────────

export const CLIENTS_SORT_COLUMNS = ['total_spent', 'total_bookings', 'last_booking_date', 'name'] as const;
export type ClientsSortColumn = (typeof CLIENTS_SORT_COLUMNS)[number];

/**
 * Статус клиента считается из данных: vip = 3+ броней ИЛИ 100k+ потрачено,
 * active = последняя бронь в течение 90 дней, inactive = иначе.
 *
 * Колонки здесь БЕЗ алиаса намеренно: выражение стоит внутри CTE `cs`, а
 * `cs.total_bookings` внутри определения самого `cs` — это и был отказ
 * «missing FROM-clause entry for table "cs"», ронявший экран целиком.
 */
const CLIENT_STATUS_EXPR = `
  CASE
    WHEN total_bookings >= 3 OR total_spent >= 100000 THEN 'vip'
    WHEN last_booking_date >= NOW() - INTERVAL '90 days'  THEN 'active'
    ELSE 'inactive'
  END`;

const CLIENTS_CTE = `
  WITH client_stats AS (
    SELECT
      u.id,
      u.name,
      u.email,
      u.phone,
      COUNT(b.id)::int AS total_bookings,
      COALESCE(SUM(
        CASE WHEN b.booking_status IN ('confirmed','completed')
             THEN COALESCE(b.final_price, b.base_total_price)::numeric ELSE 0 END
      ), 0)::numeric AS total_spent,
      MAX(b.created_at) AS last_booking_date
    FROM users u
    JOIN operator_bookings b ON b.user_id = u.id
    JOIN operator_tours t    ON b.operator_tour_id = t.id
    WHERE t.operator_id = $1
    GROUP BY u.id, u.name, u.email, u.phone
  ),
  cs AS (
    SELECT *, ${CLIENT_STATUS_EXPR} AS status FROM client_stats
  )`;

export interface ClientsSqlOptions {
  /** Есть ли параметр поиска (ILIKE по имени и почте). */
  search: boolean;
  /** Есть ли фильтр по вычисленному статусу. */
  status: boolean;
  sortCol: ClientsSortColumn;
  order: 'ASC' | 'DESC';
}

/**
 * Параметры по порядку: $1 partnerId, затем `%search%` (если search), затем
 * status (если status); у dataSql ещё limit и offset последними.
 */
export function buildClientsSql(opts: ClientsSqlOptions): { countSql: string; dataSql: string; whereParams: number } {
  const conditions: string[] = [];
  let idx = 2;
  if (opts.search) {
    conditions.push(`(cs.name ILIKE $${idx} OR cs.email ILIKE $${idx})`);
    idx += 1;
  }
  if (opts.status) {
    conditions.push(`cs.status = $${idx}`);
    idx += 1;
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sortCol: ClientsSortColumn = CLIENTS_SORT_COLUMNS.includes(opts.sortCol) ? opts.sortCol : 'total_spent';
  const order = opts.order === 'ASC' ? 'ASC' : 'DESC';
  return {
    countSql: `${CLIENTS_CTE} SELECT COUNT(*)::int AS total FROM cs ${where}`,
    dataSql: `${CLIENTS_CTE}
      SELECT cs.id, cs.name, cs.email, cs.phone,
             cs.total_bookings, cs.total_spent, cs.last_booking_date, cs.status
      FROM cs
      ${where}
      ORDER BY cs.${sortCol} ${order}
      LIMIT $${idx} OFFSET $${idx + 1}`,
    whereParams: idx - 1,
  };
}

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
 */
export const GUIDES_SQL = `
  SELECT
    g.id,
    g.name,
    g.rating,
    g.is_available,
    COUNT(DISTINCT gs.id)::text AS tours_count,
    (COUNT(DISTINCT gc.id) FILTER (WHERE gc.is_verified))::text AS verified_certifications
  FROM partners g
  LEFT JOIN guide_schedule gs ON gs.guide_id = g.id
  LEFT JOIN guide_certifications gc ON gc.guide_id = g.id
  WHERE g.category = 'guide' AND g.guide_operator_id = $1
  GROUP BY g.id, g.name, g.rating, g.is_available
  ORDER BY g.name NULLS LAST`;

/** Отказ запроса пишется с именем экрана и SQLSTATE — «не смог» не выдаётся за «пусто» (§4.0). */
export function logScreenQueryFailure(screen: string, error: unknown): void {
  const e = error as { code?: string; message?: string } | null;
  console.error(`[operator/${screen}] запрос не выполнен:`, `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(error));
}
