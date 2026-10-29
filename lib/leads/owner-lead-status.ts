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
 */
import { pool } from '@/lib/db-pool';
import { recordSourceEventQuietly, statusChangeTitle } from '@/lib/crm/events';
import type { OwnerStatusVia } from '@/lib/bookings/owner-status';
import { leadScopeCond, type LeadScope } from '@/lib/leads/ownership';

/** Все статусы, которые принимает CHECK `leads_status_check` (миграция 083). */
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

export type LeadChangeResult =
  | { kind: 'not_found' }
  | {
      kind: 'ok';
      /** Статус сменился этим запросом; false — уже был таким (или не передан). */
      changed: boolean;
      prevStatus: string;
      lead: { id: string; status: string; notes: string | null };
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
}): Promise<LeadChangeResult> {
  const { leadId, status, notes, actor, scope, via } = args;

  // Занять ничейную — только скоупу, который её видит (кабинет оператора).
  const claim = scope.kind === 'owner' && scope.claimUnowned ? scope.partnerId : null;
  const owned = leadScopeCond(scope, 6);

  // $1 — id, $2 — новый статус (NULL — не менять), $3/$4 — заметка, $5 —
  // карточка, занимающая ничейную (NULL — не занимать), дальше — скоуп.
  // Прежний статус и владение читаются под FOR UPDATE: параллельная правка
  // ждёт, и условие скоупа проверяется по её итогу (занятую другим — не
  // тронем). Строка переписывается, только если есть что менять: триггер
  // trg_leads_updated_at ставит updated_at на ЛЮБОЙ UPDATE, и повтор той же
  // отметки иначе сдвинул бы время правки.
  const res = await pool.query<{ id: string; status: string; notes: string | null; prev_status: string }>(
    `WITH prev AS (
       SELECT id, status, notes, operator_id FROM leads WHERE id = $1::uuid${owned.cond} FOR UPDATE
     ), upd AS (
       UPDATE leads l
          SET status = COALESCE($2::text, l.status),
              notes = CASE WHEN $3::boolean THEN $4::text ELSE l.notes END,
              operator_id = COALESCE(l.operator_id, $5::uuid),
              updated_at = NOW()
         FROM prev
        WHERE l.id = prev.id
          AND (($2::text IS NOT NULL AND $2::text IS DISTINCT FROM prev.status)
               OR $3::boolean
               OR (prev.operator_id IS NULL AND $5::uuid IS NOT NULL))
        RETURNING l.id, l.status, l.notes
     )
     SELECT prev.id::text AS id,
            COALESCE(upd.status, prev.status) AS status,
            CASE WHEN upd.id IS NULL THEN prev.notes ELSE upd.notes END AS notes,
            prev.status AS prev_status
       FROM prev LEFT JOIN upd ON upd.id = prev.id`,
    [leadId, status ?? null, notes !== undefined, notes ?? null, claim, ...owned.vals],
  );

  const row = res.rows[0];
  if (!row) return { kind: 'not_found' };

  const { prev_status: prevStatus, ...lead } = row;
  const changed = status !== undefined && prevStatus !== status;

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

  return { kind: 'ok', changed, prevStatus, lead };
}
