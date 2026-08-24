import { pool } from '@/lib/db-pool';
import type { JWTPayload } from '@/lib/auth/jwt';

/**
 * Скоуп владения лидом — единая формула для всех эндпоинтов /api/leads/*:
 * админ видит всё; оператор — только свои лиды и ничейные (operator_id IS NULL).
 * Оператор без записи в partners не владеет ничем — ему доступны только ничейные.
 *
 * Раньше жила только внутри app/api/leads/[id]/route.ts (GET/PATCH). Четыре
 * соседних эндпоинта того же ресурса (proposal, proposal/send, proposal/pdf,
 * process) проверяли только РОЛЬ через requireOperator, не владение —
 * оператор А мог по чужому UUID читать/скачивать PD туриста (имя, телефон,
 * email), перезапускать AI-обработку и слать предложение от имени
 * платформы (аудит кабинета оператора). Возвращает SQL-хвост условия
 * (нумерация параметров продолжается с nextIdx).
 */
export async function leadOwnershipCond(
  user: JWTPayload,
  nextIdx: number
): Promise<{ cond: string; vals: unknown[] }> {
  if (user.role === 'admin') return { cond: '', vals: [] };
  const opRes = await pool.query<{ id: string }>(
    'SELECT id FROM partners WHERE user_id = $1 LIMIT 1',
    [user.userId]
  );
  const operatorId = opRes.rows[0]?.id;
  if (!operatorId) return { cond: ' AND operator_id IS NULL', vals: [] };
  return { cond: ` AND (operator_id = $${nextIdx} OR operator_id IS NULL)`, vals: [operatorId] };
}

/**
 * Проверка владения одним лидом — true, если лид доступен этому пользователю
 * (свой/ничейный/админ). Для эндпоинтов, которым не нужен сам SELECT лида,
 * только факт доступа (proposal/send, process).
 */
export async function canAccessLead(user: JWTPayload, leadId: string): Promise<boolean> {
  const scope = await leadOwnershipCond(user, 2);
  const res = await pool.query<{ id: string }>(
    `SELECT id FROM leads WHERE id = $1${scope.cond} LIMIT 1`,
    [leadId, ...scope.vals]
  );
  return res.rows.length > 0;
}
