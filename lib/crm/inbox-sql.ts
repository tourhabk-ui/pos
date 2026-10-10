/**
 * lib/crm/inbox-sql.ts — SQL «Входящих» партнёра (CRM #2325, шаг 1г). Чтение
 * и только оно; без пула — его исполняет и интеграционный тест на настоящем
 * PostgreSQL.
 *
 * Один запрос на вид предмета, одна форма строки у всех:
 *   item_id, created_at, title, item_date, people,
 *   waiting       — предмет и сейчас ждёт ответа партнёра;
 *   responded_at  — первый ответ партнёра (NULL — не отвечал);
 *   contact_id, contact_name — клиент CRM, если предмет к нему привязан.
 *
 * Параметры у всех: $1 — partners.id, $2 — начало окна медианы ответа,
 * $3 — начало окна отзывов (только у запросов отзывов). Запрос отдаёт ждущие предметы любого возраста
 * и все предметы окна — для медианы.
 *
 * Ответ партнёра по источникам CRM — первое событие ленты по этому источнику
 * от партнёра (`partner_user`, `kuzmich`, `mcp`): подтверждение, отказ,
 * звонок, сообщение. Автоподтверждение и квалификация заявки ИИ пишутся от
 * `system` и ответом человека не считаются. У запроса мест, приглашения и
 * отзыва событий нет — у них своя метка времени ответа.
 *
 * Имени туриста у запроса мест нет намеренно: контакты туриста оператор
 * получает только после «есть места» (решение 29.09).
 */
import type { SourceKind } from '@/lib/crm/contacts';
import type { InboxKind } from '@/lib/crm/inbox-kinds';

const RESPONSE_ACTORS = `('partner_user', 'kuzmich', 'mcp')`;
const RESPONSE_EVENT_KINDS = `('status_change', 'call', 'meeting', 'message_out')`;

/** Первый ответ партнёра по источнику CRM — из ленты. */
function firstResponse(kind: SourceKind, idExpr: string): string {
  return `(SELECT min(e.occurred_at) FROM crm_events e
            WHERE e.partner_id = $1 AND e.source_kind = '${kind}' AND e.source_id = ${idExpr}
              AND e.kind IN ${RESPONSE_EVENT_KINDS} AND e.actor_kind IN ${RESPONSE_ACTORS})`;
}

/** Клиент CRM, к которому привязан источник, — только этого партнёра. */
function contactJoin(kind: SourceKind, idExpr: string): string {
  return `LEFT JOIN crm_contact_links cl ON cl.partner_id = $1 AND cl.source_kind = '${kind}' AND cl.source_id = ${idExpr}
          LEFT JOIN crm_contacts cc ON cc.id = cl.contact_id AND cc.partner_id = $1`;
}

const NO_CONTACT = `NULL::text AS contact_id, NULL::text AS contact_name`;
const CONTACT = `cc.id::text AS contact_id, cc.display_name AS contact_name`;

export const INBOX_SQL: Readonly<Record<InboxKind, string>> = {
  operator_booking: `
    SELECT b.id::text AS item_id, b.created_at, t.title, b.booking_date::text AS item_date,
           b.participants::int AS people,
           (b.booking_status = 'new') AS waiting,
           ${firstResponse('operator_booking', 'b.id::text')} AS responded_at,
           ${CONTACT}
      FROM operator_bookings b
      JOIN operator_tours t ON t.id = b.operator_tour_id
      ${contactJoin('operator_booking', 'b.id::text')}
     WHERE t.operator_id = $1 AND b.deleted_at IS NULL
       AND (b.booking_status = 'new' OR b.created_at >= $2)`,

  // Ответ — «есть места», «нет», «другая дата». Истёкший срок ответом не считается.
  seat_request: `
    SELECT r.id::text AS item_id, r.created_at, t.title, r.tour_date::text AS item_date,
           r.participants::int AS people,
           (r.status = 'pending') AS waiting,
           CASE WHEN r.status IN ('confirmed', 'declined', 'other_date') THEN r.answered_at END AS responded_at,
           ${NO_CONTACT}
      FROM tour_seat_requests r
      JOIN operator_tours t ON t.id = r.tour_id
     WHERE r.operator_id = $1
       AND (r.status = 'pending' OR r.created_at >= $2)`,

  // Только заявки, отданные этому оператору, и не его собственные пробы.
  lead: `
    SELECT l.id::text AS item_id, l.created_at, COALESCE(NULLIF(btrim(l.route_title), ''), 'Подбор тура') AS title,
           l.desired_dates AS item_date, l.group_size::int AS people,
           (l.status IN ('new', 'ai_qualified', 'awaiting_confirm')) AS waiting,
           ${firstResponse('lead', 'l.id::text')} AS responded_at,
           ${CONTACT}
      FROM leads l
      ${contactJoin('lead', 'l.id::text')}
     WHERE l.operator_id = $1 AND l.is_self = FALSE
       AND (l.status IN ('new', 'ai_qualified', 'awaiting_confirm') OR l.created_at >= $2)`,

  accommodation_booking: `
    SELECT ab.id::text AS item_id, ab.created_at, a.name AS title, ab.check_in_date::text AS item_date,
           (ab.adults + COALESCE(ab.children, 0))::int AS people,
           (ab.status = 'pending') AS waiting,
           ${firstResponse('accommodation_booking', 'ab.id::text')} AS responded_at,
           ${CONTACT}
      FROM accommodation_bookings ab
      JOIN accommodations a ON a.id = ab.accommodation_id
      ${contactJoin('accommodation_booking', 'ab.id::text')}
     WHERE a.partner_id = $1
       AND (ab.status = 'pending' OR ab.created_at >= $2)`,

  gear_rental: `
    SELECT gr.id::text AS item_id, gr.created_at, gi.name AS title, gr.start_date::text AS item_date,
           gr.quantity::int AS people,
           (gr.status = 'pending') AS waiting,
           ${firstResponse('gear_rental', 'gr.id::text')} AS responded_at,
           ${CONTACT}
      FROM gear_rentals gr
      JOIN gear_items gi ON gi.id = gr.gear_id
      ${contactJoin('gear_rental', 'gr.id::text')}
     WHERE gi.partner_id = $1
       AND (gr.status = 'pending' OR gr.created_at >= $2)`,

  transfer_seat_booking: `
    SELECT sb.id::text AS item_id, sb.created_at, (tr.from_text || ' — ' || tr.to_text) AS title,
           tr.trip_date::text AS item_date, sb.seats::int AS people,
           (sb.status = 'requested') AS waiting,
           ${firstResponse('transfer_seat_booking', 'sb.id::text')} AS responded_at,
           ${CONTACT}
      FROM transfer_seat_bookings sb
      JOIN transfer_trips tr ON tr.id = sb.trip_id
      JOIN transfer_fleet_vehicles v ON v.id = tr.vehicle_id
      ${contactJoin('transfer_seat_booking', 'sb.id::text')}
     WHERE v.partner_id = $1
       AND (sb.status = 'requested' OR sb.created_at >= $2)`,

  guide_invite: `
    SELECT i.id::text AS item_id, i.created_at, op.name AS title, NULL::text AS item_date, NULL::int AS people,
           (i.status = 'pending') AS waiting,
           CASE WHEN i.status IN ('accepted', 'declined') THEN i.responded_at END AS responded_at,
           ${NO_CONTACT}
      FROM guide_operator_invites i
      JOIN partners op ON op.id = i.operator_id
     WHERE i.guide_partner_id = $1
       AND (i.status = 'pending' OR i.created_at >= $2)`,

  // Отзыв ждёт ответа, пока он свежий: старше окна — это уже не «входящее».
  guide_review: `
    SELECT g.id::text AS item_id, g.created_at, ('Оценка ' || g.rating::text || ' из 5') AS title,
           NULL::text AS item_date, NULL::int AS people,
           (g.guide_reply IS NULL AND g.created_at >= $3) AS waiting,
           g.guide_reply_at AS responded_at,
           ${NO_CONTACT}
      FROM guide_reviews g
     WHERE g.guide_id = $1
       AND ((g.guide_reply IS NULL AND g.created_at >= $3) OR g.created_at >= $2)`,

  // Отзыв о туре оператора: тот же уговор, что у отзыва о гиде. Скрытый
  // модерацией (878) ответа не ждёт — на карточке его нет.
  tour_review: `
    SELECT r.id::text AS item_id, r.created_at, (t.title || ' · оценка ' || r.rating::text || ' из 5') AS title,
           r.trip_date::text AS item_date, NULL::int AS people,
           (r.operator_reply IS NULL AND r.created_at >= $3) AS waiting,
           r.operator_reply_at AS responded_at,
           ${NO_CONTACT}
      FROM operator_tour_reviews r
      JOIN operator_tours t ON t.id = r.tour_id
     WHERE t.operator_id = $1 AND t.deleted_at IS NULL AND r.is_hidden = FALSE
       AND ((r.operator_reply IS NULL AND r.created_at >= $3) OR r.created_at >= $2)`,
};
