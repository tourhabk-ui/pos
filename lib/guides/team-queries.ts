/**
 * SQL связки «оператор — гид — бронь» (миграция 1018) и календаря гида (1019).
 *
 * Все запросы живут здесь, а не в роутах, по той же причине, что
 * lib/operator/screen-queries.ts: форму SQL доказывает только сервер (§4.0
 * «судить статикой запрещено»), и pg-тест `tests/integration/guide-team.pg.test.ts`
 * исполняет ИМЕННО эти строки на схеме из baseline + миграций. Роут со своим
 * текстом запроса проверялся бы не тем, что работает.
 *
 * Правило доступа одно и записано в SQL, а не в коде вокруг:
 *   * членство — partners.guide_operator_id (пишет только принятие приглашения);
 *   * гид видит бронь, только если она назначена ему И он сейчас в команде
 *     оператора этой брони (`g.guide_operator_id = t.operator_id`). Вышел или
 *     исключён — имя и телефон туриста ему больше не отдаются;
 *   * оператор назначает только на СВОЮ бронь и только гида СВОЕЙ команды.
 */

/** «Сегодня» по Камчатке: брони и календарь гида живут местными датами. */
export const KAMCHATKA_TODAY = `(NOW() AT TIME ZONE 'Asia/Kamchatka')::date`;

/** Брони, которые считаются «работой»: не отменённые и не закрытые неявкой. */
const ACTIVE_BOOKING = `b.booking_status NOT IN ('cancelled', 'rejected', 'no_show')`;

export const TEAM_SQL = {
  // ── Сторона гида ─────────────────────────────────────────────────────────

  /** $1 — partners.id гида. Оператор команды или NULL. */
  membership: `
    SELECT g.guide_operator_id AS operator_id,
           COALESCE(op.company_name, op.name) AS operator_name,
           op.contacts->>'phone' AS operator_phone
      FROM partners g
      LEFT JOIN partners op ON op.id = g.guide_operator_id
     WHERE g.id = $1 AND g.category = 'guide'`,

  /** $1 — partners.id гида. Ждущие ответа приглашения. */
  pendingInvitesForGuide: `
    SELECT i.id, i.operator_id, COALESCE(op.company_name, op.name) AS operator_name,
           i.created_at
      FROM guide_operator_invites i
      JOIN partners op ON op.id = i.operator_id
     WHERE i.guide_partner_id = $1 AND i.status = 'pending'
     ORDER BY i.created_at DESC`,

  /** $1 — id приглашения, $2 — partners.id гида. Блокирует строку до ответа. */
  lockPendingInviteForGuide: `
    SELECT i.id, i.operator_id
      FROM guide_operator_invites i
     WHERE i.id = $1 AND i.guide_partner_id = $2 AND i.status = 'pending'
     FOR UPDATE`,

  /** $1 — partners.id гида. Блокирует гида: два ответа подряд не разойдутся. */
  lockGuide: `
    SELECT guide_operator_id
      FROM partners
     WHERE id = $1 AND category = 'guide'
     FOR UPDATE`,

  /** $1 — id приглашения, $2 — новый статус ('accepted' | 'declined'). */
  respondInvite: `
    UPDATE guide_operator_invites
       SET status = $2, responded_at = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING id`,

  /** $1 — partners.id гида, $2 — partners.id оператора. Единственный писатель членства. */
  setMembership: `
    UPDATE partners
       SET guide_operator_id = $2, updated_at = NOW()
     WHERE id = $1 AND category = 'guide' AND guide_operator_id IS NULL
     RETURNING id`,

  /** $1 — гид, $2 — оператор. Снимает членство, только если оно у этого оператора. */
  clearMembership: `
    UPDATE partners
       SET guide_operator_id = NULL, updated_at = NOW()
     WHERE id = $1 AND category = 'guide' AND guide_operator_id = $2
     RETURNING id`,

  /** $1 — гид, $2 — оператор, $3 — 'revoked' | 'left'. Закрывает принятое приглашение. */
  closeAcceptedInvites: `
    UPDATE guide_operator_invites
       SET status = $3, responded_at = NOW()
     WHERE guide_partner_id = $1 AND operator_id = $2 AND status = 'accepted'`,

  /** $1 — гид, $2 — оператор. Снимает гида с БУДУЩИХ броней этого оператора. */
  unassignFutureBookings: `
    UPDATE operator_bookings b
       SET guide_partner_id = NULL, updated_at = NOW()
      FROM operator_tours t
     WHERE t.id = b.operator_tour_id
       AND t.operator_id = $2
       AND b.guide_partner_id = $1
       AND COALESCE(b.end_date, b.booking_date) >= ${KAMCHATKA_TODAY}`,

  /**
   * $1 — partners.id гида. Предстоящие брони, назначенные гиду, с контактом
   * туриста (ПД: отдаются ТОЛЬКО назначенному гиду действующей команды).
   */
  assignedUpcoming: `
    SELECT b.id::text               AS booking_id,
           b.booking_date::text     AS booking_date,
           b.end_date::text         AS end_date,
           b.participants,
           b.booking_status,
           b.tourist_name,
           b.tourist_phone,
           b.special_requests,
           t.id::text               AS tour_id,
           t.title                  AS tour_title,
           t.meeting_point,
           COALESCE(op.company_name, op.name) AS operator_name
      FROM operator_bookings b
      JOIN operator_tours t ON t.id = b.operator_tour_id
      JOIN partners g       ON g.id = b.guide_partner_id
      JOIN partners op      ON op.id = t.operator_id
     WHERE b.guide_partner_id = $1
       AND g.guide_operator_id = t.operator_id
       AND b.deleted_at IS NULL AND t.deleted_at IS NULL
       AND ${ACTIVE_BOOKING}
       AND COALESCE(b.end_date, b.booking_date) >= ${KAMCHATKA_TODAY}
     ORDER BY b.booking_date, t.title, b.id
     LIMIT 200`,

  /** $1 — гид, $2/$3 — границы дат. Назначения в диапазоне БЕЗ ПД (для календаря). */
  assignedInRange: `
    SELECT b.id::text           AS booking_id,
           b.booking_date::text AS booking_date,
           t.title              AS tour_title,
           b.participants,
           b.booking_status
      FROM operator_bookings b
      JOIN operator_tours t ON t.id = b.operator_tour_id
      JOIN partners g       ON g.id = b.guide_partner_id
     WHERE b.guide_partner_id = $1
       AND g.guide_operator_id = t.operator_id
       AND b.deleted_at IS NULL AND t.deleted_at IS NULL
       AND ${ACTIVE_BOOKING}
       AND b.booking_date BETWEEN $2::date AND $3::date
     ORDER BY b.booking_date, t.title`,

  /** $1 — оператор команды, $2 — гид. Туры оператора и сколько из них назначено гиду. */
  operatorTours: `
    SELECT ot.id::text              AS id,
           ot.title,
           ot.slug,
           ot.description,
           ot.activity_type,
           ot.duration_hours::text  AS duration_hours,
           ot.base_price::text      AS base_price,
           ot.max_participants,
           (SELECT COUNT(*) FROM tour_availability ta
             WHERE ta.operator_tour_id = ot.id
               AND ta.date >= ${KAMCHATKA_TODAY}
               AND ta.deleted_at IS NULL
               AND ta.is_cancelled = FALSE)::int AS future_slots,
           (SELECT COUNT(*) FROM operator_bookings b
             WHERE b.operator_tour_id = ot.id
               AND b.guide_partner_id = $2
               AND b.deleted_at IS NULL
               AND ${ACTIVE_BOOKING}
               AND COALESCE(b.end_date, b.booking_date) >= ${KAMCHATKA_TODAY})::int AS my_assignments
      FROM operator_tours ot
     WHERE ot.operator_id = $1
       AND ot.deleted_at IS NULL
       AND ot.is_published = TRUE
     ORDER BY my_assignments DESC, future_slots DESC, ot.title`,

  // ── Сторона оператора ────────────────────────────────────────────────────

  /** $1 — e-mail аккаунта гида. Профиль гида по почте его аккаунта. */
  findGuideByEmail: `
    SELECT p.id, p.name, p.user_id, p.guide_operator_id
      FROM users u
      JOIN partners p ON p.user_id = u.id AND p.category = 'guide'
     WHERE lower(u.email) = lower($1)
     LIMIT 1`,

  /** $1 — оператор, $2 — гид, $3 — users.id пригласившего. Повтор ожидающего — не плодится. */
  insertInvite: `
    INSERT INTO guide_operator_invites (operator_id, guide_partner_id, invited_by)
    VALUES ($1, $2, $3)
    ON CONFLICT (operator_id, guide_partner_id) WHERE status = 'pending' DO NOTHING
    RETURNING id`,

  /** $1 — оператор. Ждущие и недавние приглашения. */
  operatorInvites: `
    SELECT i.id, i.status, i.created_at, i.responded_at,
           g.id AS guide_id, g.name AS guide_name
      FROM guide_operator_invites i
      JOIN partners g ON g.id = i.guide_partner_id
     WHERE i.operator_id = $1
       AND (i.status = 'pending' OR i.created_at > NOW() - INTERVAL '90 days')
     ORDER BY (i.status = 'pending') DESC, i.created_at DESC
     LIMIT 100`,

  /** $1 — приглашение, $2 — оператор. Отзыв только своего и только ждущего. */
  revokeInvite: `
    UPDATE guide_operator_invites
       SET status = 'revoked', responded_at = NOW()
     WHERE id = $1 AND operator_id = $2 AND status = 'pending'
     RETURNING id`,

  /** $1 — бронь, $2 — оператор. Бронь оператора под блокировкой. */
  lockOperatorBooking: `
    SELECT b.id::text AS id, b.guide_partner_id, b.booking_status,
           b.booking_date::text AS booking_date, t.title AS tour_title
      FROM operator_bookings b
      JOIN operator_tours t ON t.id = b.operator_tour_id
     WHERE b.id = $1::bigint AND t.operator_id = $2
       AND b.deleted_at IS NULL AND t.deleted_at IS NULL
     FOR UPDATE OF b`,

  /** $1 — гид, $2 — оператор. Гид состоит в команде оператора. */
  teamGuide: `
    SELECT id, user_id, name
      FROM partners
     WHERE id = $1 AND category = 'guide' AND guide_operator_id = $2`,

  /** $1 — бронь, $2 — гид или NULL. */
  setBookingGuide: `
    UPDATE operator_bookings
       SET guide_partner_id = $2, updated_at = NOW()
     WHERE id = $1::bigint
     RETURNING id::text AS id, guide_partner_id`,

  // ── Уведомления (без ПД туриста: только тур, дата, оператор) ────────────

  /** $1 — users.id, $2 — тип, $3 — заголовок, $4 — текст, $5 — data, $6 — ссылка. */
  notify: `
    INSERT INTO notifications (user_id, type, title, message, data, priority, action_url)
    VALUES ($1, $2, $3, $4, $5, 'normal', $6)`,
} as const;

export const SCHEDULE_SQL = {
  /** $1 — гид, $2/$3 — даты, $4 — статус или NULL. */
  list: `
    SELECT gs.id,
           gs.tour_date::text                   AS tour_date,
           to_char(gs.start_time, 'HH24:MI')    AS start_time,
           to_char(gs.end_time, 'HH24:MI')      AS end_time,
           gs.title, gs.description, gs.location_name,
           gs.max_participants, gs.participants_count,
           gs.status, gs.notes,
           gs.operator_booking_id::text         AS operator_booking_id,
           t.title                              AS tour_title,
           b.booking_status,
           gs.created_at, gs.updated_at
      FROM guide_schedule gs
      LEFT JOIN operator_bookings b
             ON b.id = gs.operator_booking_id
            AND b.guide_partner_id = gs.guide_id
            AND b.deleted_at IS NULL
      LEFT JOIN operator_tours t ON t.id = b.operator_tour_id
     WHERE gs.guide_id = $1
       AND gs.tour_date BETWEEN $2::date AND $3::date
       AND ($4::text IS NULL OR gs.status = $4::text)
     ORDER BY gs.tour_date, gs.start_time`,

  /** $1 — запись, $2 — гид. Одна запись гида. */
  one: `
    SELECT gs.id,
           gs.tour_date::text                   AS tour_date,
           to_char(gs.start_time, 'HH24:MI')    AS start_time,
           to_char(gs.end_time, 'HH24:MI')      AS end_time,
           gs.title, gs.description, gs.location_name,
           gs.max_participants, gs.participants_count,
           gs.status, gs.notes,
           gs.operator_booking_id::text         AS operator_booking_id,
           t.title                              AS tour_title,
           b.booking_status,
           gs.created_at, gs.updated_at
      FROM guide_schedule gs
      LEFT JOIN operator_bookings b
             ON b.id = gs.operator_booking_id
            AND b.guide_partner_id = gs.guide_id
            AND b.deleted_at IS NULL
      LEFT JOIN operator_tours t ON t.id = b.operator_tour_id
     WHERE gs.id = $1::uuid AND gs.guide_id = $2`,

  /**
   * $1 — гид, $2 — дата, $3 — начало, $4 — конец, $5 — исключить запись (или NULL).
   * Пересечение интервалов в пределах дня; запись без конца занимает день до полуночи.
   */
  overlap: `
    SELECT id
      FROM guide_schedule
     WHERE guide_id = $1
       AND tour_date = $2::date
       AND status <> 'cancelled'
       AND ($5::uuid IS NULL OR id <> $5::uuid)
       AND start_time < $4::time
       AND COALESCE(end_time, '24:00'::time) > $3::time
     LIMIT 1`,

  /** $1 — гид, $2 — бронь, $3 — исключить запись. На одну бронь — одна живая запись. */
  bookingEntryExists: `
    SELECT id
      FROM guide_schedule
     WHERE guide_id = $1
       AND operator_booking_id = $2::bigint
       AND status <> 'cancelled'
       AND ($3::uuid IS NULL OR id <> $3::uuid)
     LIMIT 1`,

  /** $1 — бронь, $2 — гид. Бронь назначена этому гиду действующей команды. */
  bookingAssignedToGuide: `
    SELECT b.id
      FROM operator_bookings b
      JOIN operator_tours t ON t.id = b.operator_tour_id
      JOIN partners g       ON g.id = b.guide_partner_id
     WHERE b.id = $1::bigint
       AND b.guide_partner_id = $2
       AND g.guide_operator_id = t.operator_id
       AND b.deleted_at IS NULL AND t.deleted_at IS NULL`,

  /** $1 — запись, $2 — гид. */
  ownership: `SELECT id, operator_booking_id::text AS operator_booking_id FROM guide_schedule WHERE id = $1::uuid AND guide_id = $2`,

  insert: `
    INSERT INTO guide_schedule (
      guide_id, tour_date, start_time, end_time, title, description,
      operator_booking_id, max_participants, location_name, notes, status
    ) VALUES ($1, $2::date, $3::time, $4::time, $5, $6, $7::bigint, $8, $9, $10, 'scheduled')
    RETURNING id`,
} as const;
