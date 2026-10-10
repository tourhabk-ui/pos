/**
 * lib/crm/operator-clients-sql.ts — SQL «Клиентов» оператора (CRM #2325, шаг
 * 1а-2b): контакты CRM с суммами броней и сегментом. Чтение и только оно.
 *
 * Отдельным модулем без пула и без записи намеренно. Его импортирует проба
 * прода `/api/cron/operator-screens-check`, которая лишь разбирает запросы
 * (PREPARE), — и сторож возможностей кронов судит о ней по графу импортов.
 * Импорт через `operator-clients.ts` протащил бы в пробу запись контактов
 * (`contact-queries`), которой она не делает.
 *
 * Один неизменный текст с параметрами на все фильтры, без сборки строк:
 * сборка во время работы дала бы сочетания, которые не разобрал никто (так
 * 10.09 упал прежний экран «Клиенты» — #1794).
 */
import { FREEING_BOOKING_STATUSES } from '@/lib/bookings/occupancy';
import { VIP_MIN_BOOKINGS, VIP_MIN_SUM_RUB, ACTIVE_DAYS } from '@/lib/crm/operator-segments';

/** Отменённая или отклонённая бронь не считается ни в число, ни в «последнюю». */
const FREEING = FREEING_BOOKING_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * Параметры: $1 partner_id, $2 имя/почта (LIKE) или NULL, $3 хвост телефона
 * или NULL, $4 метка или NULL — те же, что у списка контактов любого партнёра.
 */
const SEGMENTED_CTE = `
  WITH st AS (
    SELECT c.id, c.display_name, c.phone, c.email, c.tags, c.origin,
           c.first_seen_at, c.last_activity_at,
           (c.pd_consent_at IS NOT NULL) AS consent_recorded,
           (SELECT count(*)::int FROM crm_contact_links cl WHERE cl.contact_id = c.id) AS sources_count,
           COALESCE(s.bookings, 0)::int AS bookings,
           COALESCE(s.booked_sum, 0)::numeric AS booked_sum,
           s.last_booking_at
      FROM crm_contacts c
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE b.booking_status NOT IN (${FREEING})) AS bookings,
               SUM(COALESCE(b.final_price, b.base_total_price))
                 FILTER (WHERE b.booking_status IN ('confirmed', 'completed')) AS booked_sum,
               MAX(b.created_at) FILTER (WHERE b.booking_status NOT IN (${FREEING})) AS last_booking_at
          FROM crm_contact_links l
          JOIN operator_bookings b ON b.id::text = l.source_id
         WHERE l.contact_id = c.id
           AND l.partner_id = c.partner_id
           AND l.source_kind = 'operator_booking'
           AND b.deleted_at IS NULL
      ) s ON TRUE
     WHERE c.partner_id = $1
       AND ($2::text IS NULL OR lower(coalesce(c.display_name, '')) LIKE $2 OR coalesce(c.email_norm, '') LIKE $2)
       AND ($3::text IS NULL OR coalesce(c.phone_e164, '') LIKE $3)
       AND ($4::text IS NULL OR $4 = ANY(c.tags))
  ),
  seg AS (
    SELECT st.*,
           CASE
             WHEN st.bookings = 0 THEN 'none'
             WHEN st.bookings >= ${VIP_MIN_BOOKINGS} OR st.booked_sum >= ${VIP_MIN_SUM_RUB} THEN 'vip'
             WHEN st.last_booking_at >= NOW() - INTERVAL '1 day' * ${ACTIVE_DAYS} THEN 'active'
             ELSE 'inactive'
           END AS segment
      FROM st
  )`;

/** $5 сегмент или NULL, $6 порядок (`OperatorSort`), $7 limit, $8 offset. */
export const OPERATOR_CLIENTS_LIST_SQL = `${SEGMENTED_CTE}
  SELECT * FROM seg
   WHERE ($5::text IS NULL OR segment = $5)
   ORDER BY CASE WHEN $6::text = 'sum' THEN booked_sum END DESC NULLS LAST,
            CASE WHEN $6::text = 'bookings' THEN bookings END DESC NULLS LAST,
            last_activity_at DESC, id
   LIMIT $7 OFFSET $8`;

/** $5 сегмент или NULL. */
export const OPERATOR_CLIENTS_COUNT_SQL = `${SEGMENTED_CTE}
  SELECT count(*)::int AS total FROM seg WHERE ($5::text IS NULL OR segment = $5)`;

/** Итоги по всей базе оператора — плитки над списком (не по странице, как было). */
export const OPERATOR_CLIENTS_SUMMARY_SQL = `${SEGMENTED_CTE}
  SELECT count(*)::int AS clients,
         count(*) FILTER (WHERE segment = 'vip')::int AS vip,
         COALESCE(SUM(bookings), 0)::int AS bookings,
         COALESCE(SUM(booked_sum), 0)::numeric AS booked_sum
    FROM seg`;
