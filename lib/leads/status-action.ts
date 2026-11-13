/**
 * Смена статуса лида кнопкой из мессенджера.
 *
 * Правило одно на все каналы: карта payload → статус и сам UPDATE живут здесь,
 * а не в каждом вебхуке. Копия этой карты в двух вебхуках разошлась бы молча —
 * ровно та болезнь, из-за которой один лид уходил в Telegram тремя разными
 * кусками кода.
 *
 * Возвращает три исхода, не два (§4.0): статус сменён, лид не найден,
 * запрос не выполнен. «Не смог» в «не найден» не превращается.
 *
 * Четвёртый исход (1427): заявку отменил клиент — кнопка её в работу не
 * возвращает. Это не «не смог», а «нельзя», и слова у него свои.
 */

import { pool } from '@/lib/db-pool';
import { recordSourceEventQuietly, statusChangeTitle } from '@/lib/crm/events';
import { LEAD_CLIENT_CANCELLED } from '@/lib/types/statuses';

/**
 * Смена статуса кнопкой. `$1` — новый статус, `$2` — лид, `$3` — статус
 * «отменена клиентом»: такую заявку запись не трогает. Строка возвращается
 * всегда: `prev_status` NULL — лида нет, `updated` — сменён ли статус.
 */
export const LEAD_STATUS_ACTION_SQL = `
  WITH prev AS (
    SELECT status FROM leads WHERE id = $2 FOR UPDATE
  ), upd AS (
    UPDATE leads SET status = $1, updated_at = NOW()
     WHERE id = $2 AND status <> $3
    RETURNING name
  )
  SELECT (SELECT name FROM upd) AS name,
         (SELECT status FROM prev) AS prev_status,
         EXISTS (SELECT 1 FROM upd) AS updated`;

export const LEAD_STATUS_ACTIONS: Record<string, string> = {
  lead_contacted: 'contacted',
  lead_qualified: 'qualified',
  lead_converted: 'converted',
  lead_lost: 'lost',
};

export const LEAD_STATUS_LABEL: Record<string, string> = {
  contacted: 'Связались',
  qualified: 'Квалифицирован',
  converted: 'Сделка',
  lost: 'Отказ',
};

export type LeadStatusOutcome =
  | { outcome: 'updated'; status: string; label: string; name: string }
  | { outcome: 'not_found' }
  /** Заявку отменил клиент: статус не изменён и не будет. */
  | { outcome: 'cancelled_by_client' }
  | { outcome: 'failed'; reason: string };

/** Найти действие по payload вида `lead_contacted:<uuid>`. */
export function parseLeadStatusPayload(payload: string): { prefix: string; leadId: string } | null {
  const prefix = Object.keys(LEAD_STATUS_ACTIONS).find((p) => payload.startsWith(p + ':'));
  if (!prefix) return null;
  return { prefix, leadId: payload.slice(prefix.length + 1) };
}

export async function applyLeadStatus(prefix: string, leadId: string): Promise<LeadStatusOutcome> {
  const status = LEAD_STATUS_ACTIONS[prefix];
  if (!status) return { outcome: 'failed', reason: `неизвестное действие ${prefix}` };
  if (!leadId) return { outcome: 'failed', reason: 'пустой id лида' };

  try {
    const res = await pool.query<{ name: string | null; prev_status: string | null; updated: boolean }>(
      LEAD_STATUS_ACTION_SQL, [status, leadId, LEAD_CLIENT_CANCELLED],
    );
    const row = res.rows[0];
    if (!row || (!row.updated && row.prev_status === null)) return { outcome: 'not_found' };
    if (!row.updated) {
      // Строка есть, запись не прошла: условие одно — заявку отменил клиент.
      return row.prev_status === LEAD_CLIENT_CANCELLED
        ? { outcome: 'cancelled_by_client' }
        : { outcome: 'failed', reason: 'статус не записался' };
    }
    await recordSourceEventQuietly({
      kind: 'status_change', sourceKind: 'lead', sourceId: leadId, actorKind: 'partner_user',
      title: statusChangeTitle('lead', null, status), payload: { to: status, via: 'messenger' },
    });
    return { outcome: 'updated', status, label: LEAD_STATUS_LABEL[status] ?? status, name: row.name ?? '' };
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'без SQLSTATE';
    console.error(`[applyLeadStatus] ${prefix} не выполнен: SQLSTATE ${code}`);
    return { outcome: 'failed', reason: `SQLSTATE ${code}` };
  }
}
