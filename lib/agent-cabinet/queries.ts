/**
 * SQL кабинета агента (обзор и статистика) — отдельно от роутов, чтобы
 * интеграционный тест исполнял их на настоящем PostgreSQL
 * (tests/integration/agent-money.pg.test.ts): мок ответит на любой текст.
 *
 * Продажа агента — бронь оператора с agent_user_id = агент (миграция 1022).
 * Деньги агента здесь НЕ считаются — только в lib/payments/agent-commission.ts.
 */

/**
 * Период применяется к ДАТЕ БРОНИ (ob.created_at), а клиенты за период —
 * отдельным подзапросом по дате заведения клиента: брони старых клиентов не
 * выпадают из тоталов.
 */
export const DASHBOARD_SQL = {
  metrics: `
    SELECT
      (SELECT COUNT(*) FROM agent_clients c
        WHERE c.agent_id = $1::uuid
          AND c.created_at >= NOW() - ($2::int * INTERVAL '1 day'))::int AS total_clients,
      (SELECT COUNT(*) FROM agent_clients c
        WHERE c.agent_id = $1::uuid AND c.status = 'active')::int        AS active_clients,
      COUNT(ob.id)::int                                                  AS total_bookings,
      COUNT(ob.id) FILTER (WHERE ob.booking_status = ANY($3::text[]))::int AS cancelled_bookings,
      COUNT(ob.id) FILTER (WHERE ob.booking_status = 'completed')::int  AS completed_bookings,
      COUNT(ob.id) FILTER (WHERE NOT (ob.booking_status = ANY($3::text[]))
                             AND ob.paid_at IS NULL
                             AND ob.payment_status IS DISTINCT FROM 'paid')::int AS unpaid_bookings,
      COALESCE(SUM(ob.final_price) FILTER (WHERE NOT (ob.booking_status = ANY($3::text[]))
                             AND (ob.paid_at IS NOT NULL OR ob.payment_status = 'paid')), 0)::text AS paid_revenue,
      COUNT(ob.id) FILTER (WHERE NOT (ob.booking_status = ANY($3::text[]))
                             AND (ob.paid_at IS NOT NULL OR ob.payment_status = 'paid'))::int AS paid_bookings
      FROM operator_bookings ob
     WHERE ob.agent_user_id = $1::uuid
       AND ob.deleted_at IS NULL
       AND ob.created_at >= NOW() - ($2::int * INTERVAL '1 day')`,

  upcoming: `
    SELECT ob.id::text AS id, ob.tourist_name AS client_name, ot.title AS tour_name,
           ob.booking_date::text AS tour_date, ob.final_price::text AS total_price,
           (ob.paid_at IS NOT NULL OR ob.payment_status = 'paid') AS paid
      FROM operator_bookings ob
      JOIN operator_tours ot ON ot.id = ob.operator_tour_id
     WHERE ob.agent_user_id = $1::uuid
       AND ob.deleted_at IS NULL
       AND NOT (ob.booking_status = ANY($2::text[]))
       AND ob.booking_date >= CURRENT_DATE
       AND ob.booking_date <= CURRENT_DATE + 7
     ORDER BY ob.booking_date ASC
     LIMIT 10`,
} as const;

/**
 * Статистика агента. Клиент — турист продажи (почта, иначе телефон брони):
 * agent_clients.total_bookings никто не пересчитывает, и удержание по нему
 * было бы числом из воздуха. Считаются только оплаченные и не отменённые.
 * $1 — агент, $2 — статусы отмены.
 */
export const STATS_SQL = {
  retention: `
    WITH sold AS (
      SELECT COALESCE(NULLIF(LOWER(TRIM(ob.tourist_email)), ''), NULLIF(TRIM(ob.tourist_phone), '')) AS client
        FROM operator_bookings ob
       WHERE ob.agent_user_id = $1::uuid
         AND ob.deleted_at IS NULL
         AND NOT (ob.booking_status = ANY($2::text[]))
         AND (ob.paid_at IS NOT NULL OR ob.payment_status = 'paid')
    ), per_client AS (
      SELECT client, COUNT(*) AS n FROM sold WHERE client IS NOT NULL GROUP BY client
    )
    SELECT COUNT(*)::int AS clients, COUNT(*) FILTER (WHERE n > 1)::int AS repeat_clients
      FROM per_client`,

  topTours: `
    SELECT ot.title AS name, COUNT(ob.id)::int AS bookings
      FROM operator_bookings ob
      JOIN operator_tours ot ON ot.id = ob.operator_tour_id
     WHERE ob.agent_user_id = $1::uuid
       AND ob.deleted_at IS NULL
       AND NOT (ob.booking_status = ANY($2::text[]))
       AND (ob.paid_at IS NOT NULL OR ob.payment_status = 'paid')
     GROUP BY ot.id, ot.title
     ORDER BY COUNT(ob.id) DESC, ot.title
     LIMIT 5`,
} as const;
