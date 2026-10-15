import { pool } from '@/lib/db-pool';
import type { PersonalLeadOutcome } from '@/lib/notifications/lead-notify';

/**
 * Итог личной доставки заявки оператору — в журнал заявки.
 *
 * Повод — вопрос владельца 15.10 «точно приходят или опять предположения?».
 * До этого дня исход личной доставки (lib/notifications/lead-notify,
 * notifyPartnerNewLeadPersonally) уходил только строкой в рабочий чат
 * платформы и в лог сервера: задним числом ответить «дошла ли заявка до
 * оператора» было нечем, кроме как спросить самого оператора.
 *
 * Пишется в lead_activity_log (миграция 083) действием 'partner_notified'.
 * В деталях — только исход, канал и причина отказа; ПД туриста нет (имя и
 * телефон живут в самой заявке). Время — ISO из приложения, а не DEFAULT NOW()
 * колонки: у created_at тип TIMESTAMP без зоны, и смысл его зависит от часового
 * пояса сессии (у ручных записей миграций он оказывался московским, см.
 * prod-check run130). Отказ записи не глушится: имя проверки и SQLSTATE — в лог.
 */

export const PARTNER_NOTIFIED_ACTION = 'partner_notified';

export interface PartnerDelivery {
  lead_id: string;
  at: string;
  state: PersonalLeadOutcome['state'];
  channel: string | null;
  reason: string | null;
}

export async function recordPartnerDelivery(
  leadId: string,
  operatorId: string,
  outcome: PersonalLeadOutcome,
  now: Date = new Date(),
): Promise<boolean> {
  const details = {
    operator_id: operatorId,
    at: now.toISOString(),
    state: outcome.state,
    channel: 'channel' in outcome ? outcome.channel : null,
    reason: outcome.state === 'failed' ? outcome.reason.slice(0, 300) : null,
  };
  try {
    await pool.query(
      `INSERT INTO lead_activity_log (lead_id, actor, action, details)
       VALUES ($1, 'system', $2, $3::jsonb)`,
      [leadId, PARTNER_NOTIFIED_ACTION, JSON.stringify(details)],
    );
    return true;
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error(`[lead-delivery] итог доставки заявки ${leadId} не записан:`, e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return false;
  }
}

/**
 * Последний записанный итог доставки по каждому оператору из списка.
 * null вместо карты — «не смог прочитать» (§4.0), это не «записей нет».
 */
export async function lastPartnerDeliveries(operatorIds: string[]): Promise<Map<string, PartnerDelivery> | null> {
  const out = new Map<string, PartnerDelivery>();
  if (operatorIds.length === 0) return out;
  try {
    const { rows } = await pool.query<{ operator_id: string; lead_id: string; details: Record<string, unknown> }>(
      `SELECT DISTINCT ON (details->>'operator_id')
              details->>'operator_id' AS operator_id, lead_id::text AS lead_id, details
         FROM lead_activity_log
        WHERE action = $1
          AND details->>'operator_id' = ANY($2::text[])
        ORDER BY details->>'operator_id', id DESC`,
      [PARTNER_NOTIFIED_ACTION, operatorIds],
    );
    for (const r of rows) {
      const d = r.details ?? {};
      const state = typeof d.state === 'string' ? d.state : null;
      const at = typeof d.at === 'string' ? d.at : null;
      if (!state || !at) continue;
      out.set(r.operator_id, {
        lead_id: r.lead_id,
        at,
        state: state as PartnerDelivery['state'],
        channel: typeof d.channel === 'string' ? d.channel : null,
        reason: typeof d.reason === 'string' ? d.reason : null,
      });
    }
    return out;
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error('[lead-delivery] итоги доставки не прочитаны:', e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return null;
  }
}
