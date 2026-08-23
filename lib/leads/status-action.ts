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
 */

import { pool } from '@/lib/db-pool';

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
    const res = await pool.query<{ name: string }>(
      `UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING name`,
      [status, leadId],
    );
    const row = res.rows[0];
    if (!row) return { outcome: 'not_found' };
    return { outcome: 'updated', status, label: LEAD_STATUS_LABEL[status] ?? status, name: row.name };
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'без SQLSTATE';
    console.error(`[applyLeadStatus] ${prefix} не выполнен: SQLSTATE ${code}`);
    return { outcome: 'failed', reason: `SQLSTATE ${code}` };
  }
}
