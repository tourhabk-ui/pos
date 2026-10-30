import { pool } from '@/lib/db-pool';
import type { JWTPayload } from '@/lib/auth/jwt';
import { operatorAccess } from '@/lib/operators/team-access';

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
 * платформы (аудит кабинета оператора).
 *
 * С 29.10 у формулы два входа: кабинет оператора (`operatorLeadScope`) и
 * раздел «Свои туры» гида — скоуп `{ kind: 'owner', claimUnowned: false }`:
 * гид отвечает только на заявки, адресованные ему, ничейные не видит и не
 * занимает (lib/leads/owner-lead-status).
 */
export type LeadScope =
  /** Администратор: любой лид. */
  | { kind: 'admin' }
  /**
   * Продавец: лиды его карточки. `claimUnowned` — видит и ничейные, и первое
   * действие над ничейным делает его своим (кабинет оператора, 25.09).
   */
  | { kind: 'owner'; partnerId: string; claimUnowned: boolean }
  /** Оператор без карточки партнёра: только ничейные, занять нечем. */
  | { kind: 'unowned_only' };

/**
 * Скоуп кабинета оператора. Кабинет — свой или команды (CRM 2г, миграция
 * 1223): менеджер видит лиды своего оператора. operatorAccess ищет партнёра
 * только category='operator' — у user_id бывает и гид-профиль, LIMIT 1 без
 * фильтра брал произвольный.
 */
export async function operatorLeadScope(user: JWTPayload): Promise<LeadScope> {
  if (user.role === 'admin') return { kind: 'admin' };
  const access = await operatorAccess(user.userId);
  // «Не смогли проверить» — не «партнёра нет»: иначе оператор молча увидел бы
  // только ничейные лиды. Бросаем — роут отвечает ошибкой, как при сбое базы.
  if (access.kind === 'unavailable') throw new Error(`доступ к кабинету не проверен: ${access.reason}`);
  if (access.kind === 'none') return { kind: 'unowned_only' };
  return { kind: 'owner', partnerId: access.partnerId, claimUnowned: true };
}

/**
 * SQL-хвост условия по скоупу (нумерация параметров продолжается с nextIdx).
 * Колонка — `operator_id` таблицы leads без псевдонима.
 */
export function leadScopeCond(scope: LeadScope, nextIdx: number): { cond: string; vals: unknown[] } {
  switch (scope.kind) {
    case 'admin':
      return { cond: '', vals: [] };
    case 'unowned_only':
      return { cond: ' AND operator_id IS NULL', vals: [] };
    case 'owner':
      return scope.claimUnowned
        ? { cond: ` AND (operator_id = $${nextIdx} OR operator_id IS NULL)`, vals: [scope.partnerId] }
        : { cond: ` AND operator_id = $${nextIdx}`, vals: [scope.partnerId] };
  }
}

/** Условие владения для кабинета оператора — `leadScopeCond(operatorLeadScope(user))`. */
export async function leadOwnershipCond(
  user: JWTPayload,
  nextIdx: number
): Promise<{ cond: string; vals: unknown[] }> {
  return leadScopeCond(await operatorLeadScope(user), nextIdx);
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
