/**
 * Volcano OS — agent_effects: durable intent внешнего эффекта.
 *
 * 917 отложила exactly-once «отдельным этапом» (agent_kernel.sql:16-21):
 * effect_started/effect_committed в agent_events давали наблюдаемость, но
 * окно сбоя между внешним commit (создание PR, отправка сообщения) и
 * записью события оставалось. Эта пара примитивов закрывает окно ТАМ, где
 * его можно закрыть — durable-строкой ДО вызова внешнего API:
 *
 *   beginEffect  — INSERT ... ON CONFLICT (task_id, effect_key) DO NOTHING.
 *                  Конфликт → читаем существующую строку: committed
 *                  возвращается как ФАКТ (эффект уже случился, не
 *                  повторять); pending — честная неопределённость (§4.0):
 *                  предыдущая попытка либо ещё идёт, либо упала между
 *                  внешним вызовом и commitEffect, и этого узнать нельзя
 *                  ИЗНУТРИ этой таблицы — решает вызывающий (для GitHub PR
 *                  решение конкретное: проверить, нет ли уже открытого PR
 *                  по ветке, см. code-change-executor.ts).
 *   commitEffect — атомарный UPDATE ... WHERE status='pending', тот же
 *                  паттерн guard-перехода, что у kernel.ts's transition().
 *   failEffect   — тот же паттерн, status='failed'.
 *
 * Событие ядра (effect_started/effect_committed в agent_events) НЕ
 * убирается — лента кокпита их показывает как раньше; эти примитивы
 * пишут СВОЮ строку в agent_effects рядом, не вместо.
 */

import { randomUUID } from 'node:crypto';
import { pool } from '@/lib/db-pool';

export type EffectStatus = 'pending' | 'committed' | 'failed';

export interface AgentEffect {
  id: string;
  task_id: string;
  effect_key: string;
  status: EffectStatus;
  external_ref: string | null;
  details: Record<string, unknown>;
  created_at: string;
  committed_at: string | null;
}

interface EffectRow extends AgentEffect { [k: string]: unknown }

const EFFECT_COLUMNS = `id, task_id, effect_key, status, external_ref, details,
  created_at::text, committed_at::text`;

export type BeginEffectResult =
  | { outcome: 'started'; effect: AgentEffect }
  | { outcome: 'already_committed'; effect: AgentEffect }
  /** Предыдущая попытка либо ещё идёт, либо упала между вызовом и commit — неизвестно (§4.0). */
  | { outcome: 'pending_unknown'; effect: AgentEffect };

/**
 * Завести durable intent эффекта ДО вызова внешнего API. Идемпотентно по
 * (task_id, effect_key): повторный вызов с тем же ключом не создаёт вторую
 * попытку, а честно отдаёт, что уже известно об этой попытке.
 */
export async function beginEffect(
  taskId: string,
  effectKey: string,
  details?: Record<string, unknown>,
): Promise<BeginEffectResult> {
  const { rows } = await pool.query<EffectRow>(
    `INSERT INTO agent_effects (id, task_id, effect_key, status, details)
     VALUES ($1, $2, $3, 'pending', $4)
     ON CONFLICT (task_id, effect_key) DO NOTHING
     RETURNING ${EFFECT_COLUMNS}`,
    [randomUUID(), taskId, effectKey, JSON.stringify(details ?? {})],
  );
  const started = rows[0];
  if (started) return { outcome: 'started', effect: started };

  // Конфликт: строка уже есть — читаем, что там.
  const { rows: existingRows } = await pool.query<EffectRow>(
    `SELECT ${EFFECT_COLUMNS} FROM agent_effects WHERE task_id = $1 AND effect_key = $2`,
    [taskId, effectKey],
  );
  const existing = existingRows[0];
  if (!existing) {
    // Гонка «строка удалена между INSERT и SELECT» — таблица append-only по
    // конвенции (не по триггеру, в отличие от agent_events), такого не
    // ожидается; честный отказ вместо тихой выдумки.
    throw new Error(`agent_effects: конфликт по (${taskId}, ${effectKey}), но строка не найдена — повторите`);
  }
  return existing.status === 'committed'
    ? { outcome: 'already_committed', effect: existing }
    : { outcome: 'pending_unknown', effect: existing };
}

/** Атомарно закрыть эффект как исполненный. WHERE status='pending' — гонку решает БД. */
export async function commitEffect(
  effectId: string,
  externalRef: string | null,
  details?: Record<string, unknown>,
): Promise<{ ok: boolean; reason?: string }> {
  const { rowCount } = await pool.query(
    `UPDATE agent_effects
     SET status = 'committed', external_ref = $2, committed_at = NOW(),
         details = details || $3::jsonb
     WHERE id = $1 AND status = 'pending'`,
    [effectId, externalRef, JSON.stringify(details ?? {})],
  );
  if ((rowCount ?? 0) === 0) {
    return { ok: false, reason: 'эффект не в состоянии pending — переход не выполнен' };
  }
  return { ok: true };
}

/** Атомарно закрыть эффект как проваленный. Тот же guard, что у commitEffect. */
export async function failEffect(
  effectId: string,
  reason: string,
): Promise<{ ok: boolean; reason?: string }> {
  const { rowCount } = await pool.query(
    `UPDATE agent_effects
     SET status = 'failed', details = details || $2::jsonb
     WHERE id = $1 AND status = 'pending'`,
    [effectId, JSON.stringify({ failure_reason: reason })],
  );
  if ((rowCount ?? 0) === 0) {
    return { ok: false, reason: 'эффект не в состоянии pending — переход не выполнен' };
  }
  return { ok: true };
}

/** Зависшие эффекты: pending дольше ledgerMinutes — кокпит показывает их вместо тишины. */
export async function findStuckEffects(ledgerMinutes = 15): Promise<AgentEffect[]> {
  const { rows } = await pool.query<EffectRow>(
    `SELECT ${EFFECT_COLUMNS} FROM agent_effects
     WHERE status = 'pending' AND created_at < NOW() - ($1 || ' minutes')::interval
     ORDER BY created_at ASC
     LIMIT 50`,
    [String(ledgerMinutes)],
  );
  return rows;
}
