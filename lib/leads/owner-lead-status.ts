/**
 * Смена статуса заявки (лида) тем, кто её ведёт, — одно правило на двери:
 * кабинет оператора (`PATCH /api/leads/[id]`) и раздел «Свои туры» гида
 * (`PATCH /api/guide/own/leads/[id]`, 29.10: гид продаёт свои туры (1338), а
 * заявку на них отметить было негде — дверь заявок пускала одного
 * оператора, и во «Входящих» гида заявка висела бы без ответа вечно).
 *
 * Кто вправе — решает дверь и передаёт скоуп (lib/leads/ownership):
 * оператор видит свои и ничейные и первым действием занимает ничейную;
 * гид — только адресованные ему, ничейную не видит и не занимает. Чужая
 * заявка неотличима от несуществующей: `not_found`, а не «нельзя».
 *
 * Здесь — что происходит с заявкой, одинаково для всех: прежний статус
 * читается под блокировкой строки В ТОМ ЖЕ запросе, что и запись (два
 * параллельных нажатия не запишут два события «новая → связались»), событие
 * в ленту клиента — только когда статус правда сменился.
 *
 * Повтор того же статуса — не событие (как у брони, lib/bookings/owner-status):
 * ни второго события в ленте, ни нового `updated_at` (по нему недельная
 * сводка считает сделки — повторное «Договорились» не сделало бы старую
 * сделку новой). Исход говорит `changed: false`, и дверь отвечает «уже».
 *
 * Заявку, которую отменил клиент (`cancelled`, 1427), в работу не возвращают:
 * ни статусом, ни занятием ничейной. Запрет стоит здесь, в самой записи, а не
 * у дверей — их семь (кабинет, гид, кнопки в MAX и Telegram, администратор,
 * перевозчик, прокат), и «Связался» по отменённой заявке иначе воскресил бы
 * её у любой из них. Заметку к такой заявке писать можно. Исход говорит
 * `prevStatus: 'cancelled'` и `changed: false` — дверь отвечает «отменена
 * клиентом».
 *
 * Отказ с причиной (план «после отказа», этап 3а): дверь, которая спрашивает
 * у продавца причину, передаёт её в `lost`. Причина ложится в саму заявку
 * (`leads.lost_reason`, 1429) — её читает статус для человека; при любой
 * следующей смене статуса её стирает триггер. Запись журнала `seller_closed` и
 * — у отказа продавца — строка сообщения человеку (`answer_notices`) рождаются
 * ТЕМ ЖЕ запросом, что и смена статуса: заявка не останется закрытой без
 * записи «к отправке», и повтор нажатия второго сообщения не даст (статус уже
 * `lost` — записи нет). Отправляет сообщение дверь (deliverAnswerNotice), обрыв
 * подбирает добивка. Двери без `lost` (кнопка «Отказать» в чате со своей
 * записью ответа, администратор) работают как раньше.
 */
import { pool } from '@/lib/db-pool';
import { recordSourceEventQuietly, statusChangeTitle } from '@/lib/crm/events';
import type { OwnerStatusVia } from '@/lib/bookings/owner-status';
import { leadScopeCond, type LeadScope } from '@/lib/leads/ownership';
import { LEAD_CLIENT_CANCELLED } from '@/lib/types/statuses';
import { SELLER_CLOSED_ACTION, lostReasonTellsTourist, type LostReason } from '@/lib/leads/lost-reason';

/**
 * Статусы, которые ставит продавец, администратор или конвейер. `cancelled`
 * (1427) в CHECK тоже есть, но здесь его нет намеренно: его ставит только
 * отмена клиентом (lib/requests/cancel-request), и вручную его не выбрать.
 */
export const LEAD_STATUSES = [
  'new',
  'ai_processing',
  'ai_qualified',
  'proposal_sent',
  'awaiting_confirm',
  'contacted',
  'qualified',
  'converted',
  'lost',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Запись о сообщении человеку, рождённая отказом продавца. */
export interface LostNotice { id: string; state: 'pending' | 'skipped'; skipped: string | null }

/** Причина отказа и кто отказывает — от двери, которая спросила причину. */
export interface LostBy {
  reason: LostReason;
  /**
   * Карточка продавца, который закрывает заявку. Сообщение человеку рождается
   * «к отправке», только если заявка была адресована ЭТОЙ карточке: ничейную,
   * которую кабинет занял этим же действием, человек этому продавцу не слал.
   */
  partnerId: string;
}

export type LeadChangeResult =
  | { kind: 'not_found' }
  | {
      kind: 'ok';
      /** Статус сменился этим запросом; false — уже был таким (или не передан). */
      changed: boolean;
      prevStatus: string;
      lead: { id: string; status: string; notes: string | null };
      /**
       * Закрытие с причиной записано этим запросом (журнал `seller_closed`).
       * `notice` — строка сообщения человеку: только у отказа продавца; null —
       * причина на стороне клиента, сообщать нечего. Поля нет — отказа с
       * причиной этот запрос не записал.
       */
      closed?: { activityId: string; notice: LostNotice | null };
    };

/**
 * Меняет статус и (или) заметку заявки в пределах скоупа. Отказ базы не
 * глушится — бросает с SQLSTATE, дверь отвечает «не записано».
 */
export async function changeLeadStatus(args: {
  leadId: string;
  status?: LeadStatus;
  notes?: string;
  actor: { kind: 'admin' | 'partner_user'; userId: string | null };
  scope: LeadScope;
  via: OwnerStatusVia;
  /** Причина отказа — только вместе со `status: 'lost'`; иначе не читается. */
  lost?: LostBy;
}): Promise<LeadChangeResult> {
  const { leadId, status, notes, actor, scope, via } = args;
  const lost = status === 'lost' ? args.lost : undefined;

  // Занять ничейную — только скоупу, который её видит (кабинет оператора).
  const claim = scope.kind === 'owner' && scope.claimUnowned ? scope.partnerId : null;
  const owned = leadScopeCond(scope, 6);

  // $1 — id, $2 — новый статус (NULL — не менять), $3/$4 — заметка, $5 —
  // карточка, занимающая ничейную (NULL — не занимать), дальше — скоуп, за ним
  // пять параметров отказа с причиной (все NULL/false — отказа с причиной нет).
  // Прежний статус и владение читаются под FOR UPDATE: параллельная правка
  // ждёт, и условие скоупа проверяется по её итогу (занятую другим — не
  // тронем). Строка переписывается, только если есть что менять: триггер
  // trg_leads_updated_at ставит updated_at на ЛЮБОЙ UPDATE, и повтор той же
  // отметки иначе сдвинул бы время правки.
  // Номера параметров отказа — после скоупа: его хвост бывает пустым.
  const p = 6 + owned.vals.length;
  const [pReason, pActor, pVia, pTell, pPartner] = [p, p + 1, p + 2, p + 3, p + 4].map((n) => `$${n}`);
  const res = await pool.query<{
    id: string; status: string; notes: string | null; prev_status: string;
    closed_id: string | null; notice_id: string | null; notice_state: 'pending' | 'skipped' | null; notice_skip: string | null;
  }>(
    `WITH prev AS (
       SELECT id, status, notes, operator_id, is_self, source_data->>'kind' AS kind
         FROM leads WHERE id = $1::uuid${owned.cond} FOR UPDATE
     ), upd AS (
       UPDATE leads l
          SET status = CASE WHEN prev.status = '${LEAD_CLIENT_CANCELLED}' THEN l.status ELSE COALESCE($2::text, l.status) END,
              notes = CASE WHEN $3::boolean THEN $4::text ELSE l.notes END,
              operator_id = CASE WHEN prev.status = '${LEAD_CLIENT_CANCELLED}' THEN l.operator_id ELSE COALESCE(l.operator_id, $5::uuid) END,
              -- Причина — только у закрытия этим запросом (1429). Остальное решает
              -- триггер: статус сменился без новой причины — прежняя стирается.
              lost_reason = CASE WHEN $2::text = 'lost' AND prev.status NOT IN ('lost', '${LEAD_CLIENT_CANCELLED}')
                                 THEN ${pReason}::text ELSE l.lost_reason END,
              updated_at = NOW()
         FROM prev
        WHERE l.id = prev.id
          AND (($2::text IS NOT NULL AND $2::text IS DISTINCT FROM prev.status AND prev.status <> '${LEAD_CLIENT_CANCELLED}')
               OR $3::boolean
               OR (prev.operator_id IS NULL AND $5::uuid IS NOT NULL AND prev.status <> '${LEAD_CLIENT_CANCELLED}'))
        RETURNING l.id, l.status, l.notes
     ), closed AS (
       -- Отказ с причиной: только когда статус ЭТИМ запросом стал «lost».
       -- Повтор и заметка к уже закрытой заявке записи не дают.
       INSERT INTO lead_activity_log (lead_id, actor, action, details)
       SELECT upd.id, ${pActor}::text, '${SELLER_CLOSED_ACTION}',
              jsonb_build_object('reason', ${pReason}::text, 'via', ${pVia}::text, 'from', prev.status)
         FROM upd JOIN prev ON prev.id = upd.id
        WHERE ${pReason}::text IS NOT NULL AND upd.status = 'lost' AND prev.status IS DISTINCT FROM 'lost'
       RETURNING id
     ), note AS (
       -- Сообщение человеку — только об отказе продавца. Сразу «пропущено»,
       -- если заявка не была адресована этой карточке или это своя проба:
       -- тот же выбор, что у ответа кнопкой (CHAT_ANSWER_INSERT_SQL). Иначе —
       -- «ждёт» с захватом на 5 минут: отправляет дверь, добивка — после.
       INSERT INTO answer_notices (lead_id, activity_id, answer, decline_reason, lead_status_before,
                                   state, skipped_reason, claimed_until, decided_at)
       SELECT prev.id, closed.id, 'decline', ${pReason}::text, prev.status,
              CASE WHEN s.skip IS NULL THEN 'pending' ELSE 'skipped' END, s.skip,
              CASE WHEN s.skip IS NULL THEN NOW() + INTERVAL '5 minutes' END,
              CASE WHEN s.skip IS NOT NULL THEN NOW() END
         FROM closed CROSS JOIN prev
        CROSS JOIN LATERAL (
          SELECT CASE WHEN prev.operator_id IS DISTINCT FROM ${pPartner}::uuid THEN 'not_addressee'
                      WHEN prev.is_self THEN 'self' END AS skip
        ) s
        -- Заявка на машину и прокат сюда не попадает: у неё свой ответ
        -- («Не могу», lib/rental/request-answer-store) и свои слова.
        WHERE ${pTell}::boolean AND COALESCE(prev.kind, '') NOT IN ('charter', 'car_rental')
       RETURNING id, state, skipped_reason
     )
     SELECT prev.id::text AS id,
            COALESCE(upd.status, prev.status) AS status,
            CASE WHEN upd.id IS NULL THEN prev.notes ELSE upd.notes END AS notes,
            prev.status AS prev_status,
            (SELECT id::text FROM closed) AS closed_id,
            (SELECT id::text FROM note) AS notice_id,
            (SELECT state FROM note) AS notice_state,
            (SELECT skipped_reason FROM note) AS notice_skip
       FROM prev LEFT JOIN upd ON upd.id = prev.id`,
    [
      leadId, status ?? null, notes !== undefined, notes ?? null, claim, ...owned.vals,
      lost?.reason ?? null, actor.kind === 'admin' ? 'admin' : 'partner', via,
      lost ? lostReasonTellsTourist(lost.reason) : false, lost?.partnerId ?? null,
    ],
  );

  const row = res.rows[0];
  if (!row) return { kind: 'not_found' };

  const {
    prev_status: prevStatus, closed_id: closedId, notice_id: noticeId, notice_state: noticeState, notice_skip: noticeSkip, ...lead
  } = row;
  // «Сменился» — по тому, что записано, а не по тому, что прислали: у отменённой клиентом статус не трогается.
  const changed = status !== undefined && prevStatus !== status && lead.status === status;

  // Лента клиента (CRM #2325): событие — когда статус сменился, а не когда
  // его прислали тем же. Канал — как у брони (план мини-приложения, §6.7).
  if (changed) {
    await recordSourceEventQuietly({
      kind: 'status_change', sourceKind: 'lead', sourceId: lead.id,
      actorKind: actor.kind, actorUserId: actor.userId,
      title: statusChangeTitle('lead', prevStatus, status),
      payload: { from: prevStatus, to: status, via },
    });
  }

  const closed = closedId
    ? { activityId: closedId, notice: noticeId && noticeState ? { id: noticeId, state: noticeState, skipped: noticeSkip } : null }
    : undefined;
  return { kind: 'ok', changed, prevStatus, lead, ...(closed ? { closed } : {}) };
}
