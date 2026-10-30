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
import { LEAD_WAITING_STATUSES } from '@/lib/leads/owner-lead-words';
import { leadPeopleSql } from '@/lib/leads/lead-people';

const RESPONSE_ACTORS = `('partner_user', 'kuzmich', 'mcp')`;
/** Заявка ждёт ответа — один набор с разделом «Свои туры» гида (lib/leads/owner-lead-words). */
const LEAD_WAITING_SQL = `(${LEAD_WAITING_STATUSES.map((s) => `'${s}'`).join(', ')})`;
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
  // Ответ в переписке с клиентом (1350) — тоже ответ: заявка, на которую
  // партнёр уже написал клиенту, не висит «ждёт ответа», даже если статус ещё
  // не переведён. Первое сообщение партнёра идёт и в медиану. Число людей —
  // только записанное дверью (lib/leads/lead-people): `group_size` не пишет
  // никто, и «1 чел» у каждой заявки было выдумкой (§4.0).
  lead: `
    SELECT l.id::text AS item_id, l.created_at, COALESCE(NULLIF(btrim(l.route_title), ''), 'Подбор тура') AS title,
           l.desired_dates AS item_date, ${leadPeopleSql('l')} AS people,
           (l.status IN ${LEAD_WAITING_SQL} AND lm.first_at IS NULL) AS waiting,
           LEAST(${firstResponse('lead', 'l.id::text')}, lm.first_at) AS responded_at,
           ${CONTACT}
      FROM leads l
      CROSS JOIN LATERAL (
        SELECT min(m.created_at) AS first_at FROM request_messages m
         WHERE m.lead_id = l.id AND m.author = 'owner'
      ) lm
      ${contactJoin('lead', 'l.id::text')}
     WHERE l.operator_id = $1 AND l.is_self = FALSE
       AND ((l.status IN ${LEAD_WAITING_SQL} AND lm.first_at IS NULL) OR l.created_at >= $2)`,

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

  // Заявка хозяину жилья (1206). Ответ — первое сообщение хозяина в переписке
  // (1349) или его касание в ленте («запиши звонок»): звонка самого платформа
  // не видит. Ждёт ответа, пока не наступил день заезда по Камчатке.
  stay_request: `
    SELECT x.* FROM (
      SELECT s.id::text AS item_id, s.created_at, a.name AS title, s.check_in_date::text AS item_date,
             s.guests::int AS people,
             (r.responded_at IS NULL AND s.check_in_date >= (NOW() AT TIME ZONE 'Asia/Kamchatka')::date) AS waiting,
             r.responded_at,
             ${CONTACT}
        FROM stay_requests s
        JOIN accommodations a ON a.id = s.accommodation_id
        CROSS JOIN LATERAL (
          SELECT LEAST(
                   (SELECT min(m.created_at) FROM request_messages m
                     WHERE m.stay_request_id = s.id AND m.author = 'owner'),
                   ${firstResponse('stay_request', 's.id::text')}
                 ) AS responded_at
        ) r
        ${contactJoin('stay_request', 's.id::text')}
       WHERE a.partner_id = $1
    ) x
     WHERE x.waiting OR x.created_at >= $2`,

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

  // Заявка на машину целиком перевозчику (#2862 этап A): лид с
  // source_data.kind = 'charter' (lib/transfers/charter-request). Ответ —
  // «Беру» / «Не могу» (lead_activity_log.partner_answered, один на заявку,
  // 1326), первое сообщение перевозчика в переписке (1350) или его касание в
  // ленте; время ответа — `at` из деталей журнала (ISO из приложения). Ждёт,
  // пока нет ответа, статус ждущий и день выезда по Камчатке не прошёл: о
  // поездке на вчера отвечать поздно, и висеть вечно она не должна. Факты —
  // из структурных полей заявки, не из комментария: направление, дата
  // выезда, люди. Направление пишет заказчик словами — `inboxItemField`
  // прогонит его через redactPII на экране чата (TOURIST_TEXT_KINDS).
  charter_request: `
    SELECT x.* FROM (
      SELECT l.id::text AS item_id, l.created_at,
             COALESCE(NULLIF(btrim(l.source_data->>'destination'), ''), NULLIF(btrim(l.route_title), ''), 'Машина под заказ') AS title,
             NULLIF(btrim(l.source_data->>'date_from'), '') AS item_date,
             CASE WHEN l.source_data->>'passengers' ~ '^[0-9]{1,4}$' THEN (l.source_data->>'passengers')::int END AS people,
             (pa.answers = 0 AND lm.first_at IS NULL
               AND l.status IN ${LEAD_WAITING_SQL}
               AND COALESCE(
                 CASE WHEN l.source_data->>'date_from' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                      THEN (l.source_data->>'date_from')::date >= (NOW() AT TIME ZONE 'Asia/Kamchatka')::date END,
                 TRUE)) AS waiting,
             LEAST(${firstResponse('lead', 'l.id::text')}, lm.first_at, pa.answered_at) AS responded_at,
             ${CONTACT}
        FROM leads l
        CROSS JOIN LATERAL (
          SELECT min(m.created_at) AS first_at FROM request_messages m
           WHERE m.lead_id = l.id AND m.author = 'owner'
        ) lm
        CROSS JOIN LATERAL (
          SELECT count(*)::int AS answers,
                 min(CASE WHEN a.details->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}' THEN (a.details->>'at')::timestamptz END) AS answered_at
            FROM lead_activity_log a
           WHERE a.lead_id = l.id AND a.action = 'partner_answered'
        ) pa
        ${contactJoin('lead', 'l.id::text')}
       WHERE l.operator_id = $1 AND l.is_self = FALSE
         AND l.source_data->>'kind' = 'charter'
    ) x
     WHERE x.waiting OR x.created_at >= $2`,

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

  // Отзыв гостя о жилье (ответ — миграция 1208). Скрытый модерацией ответа не ждёт.
  stay_review: `
    SELECT r.id::text AS item_id, r.created_at, (a.name || ' · оценка ' || r.overall_rating::text || ' из 5') AS title,
           NULL::text AS item_date, NULL::int AS people,
           (r.owner_reply IS NULL AND r.created_at >= $3) AS waiting,
           r.owner_reply_at AS responded_at,
           ${NO_CONTACT}
      FROM accommodation_reviews r
      JOIN accommodations a ON a.id = r.accommodation_id
     WHERE a.partner_id = $1 AND r.is_visible IS NOT FALSE
       AND ((r.owner_reply IS NULL AND r.created_at >= $3) OR r.created_at >= $2)`,
};
