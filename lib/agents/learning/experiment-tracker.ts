/**
 * ExperimentTracker — A/B тестирование для агентных промптов/стратегий.
 *
 * Позволяет безопасно сравнивать два подхода без изменения продакшна.
 * Всё хранится в agent_experiments + ai_actions_log.
 *
 * Пример использования:
 *   const tracker = new ExperimentTracker();
 *   const exp = await tracker.create({ name: 'digest-format-v2', intent: 'admin_digest', ... });
 *   const variant = tracker.pickVariant(exp.id);
 *   // ... run variant logic ...
 *   await tracker.recordResult(exp.id, variant, 'success', 340);
 */

import { pool } from '@/lib/db-pool';

export interface Experiment {
  id:          string;
  name:        string;
  description: string | null;
  intent:      string | null;
  variant_a:   Record<string, unknown>;
  variant_b:   Record<string, unknown>;
  metric:      string;
  status:      'running' | 'paused' | 'completed';
  winner:      'a' | 'b' | 'tie' | null;
  results:     Record<string, unknown>;
  created_at:  Date;
  updated_at:  Date;
}

export interface CreateExperimentParams {
  name:         string;
  description?: string;
  intent?:      string;
  variant_a:    Record<string, unknown>;
  variant_b:    Record<string, unknown>;
  metric?:      string;
}

export interface WilsonInterval { low: number; high: number }

export interface ExperimentResults {
  variant_a: { success: number; fail: number; rate: number; ci: WilsonInterval };
  variant_b: { success: number; fail: number; rate: number; ci: WilsonInterval };
  winner:    'a' | 'b' | 'tie' | null;
  total:     number;
}

/**
 * Wilson score-интервал для доли (z=1.96 ≈ 95%). Корректен у краёв (p→0/1)
 * и при малом N — в отличие от нормального приближения. Книга (Roitman, §14.4.4):
 * победителя объявляем только если доверительные интервалы НЕ пересекаются.
 */
export function wilsonInterval(success: number, total: number, z = 1.96): WilsonInterval {
  if (total <= 0) return { low: 0, high: 0 };
  const p = success / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

interface ResultRow {
  variant: string;
  outcome: string;
  count:   string;
}

export class ExperimentTracker {
  async create(params: CreateExperimentParams): Promise<Experiment> {
    const { rows } = await pool.query<Experiment>(`
      INSERT INTO agent_experiments (name, description, intent, variant_a, variant_b, metric)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      params.name,
      params.description ?? null,
      params.intent ?? null,
      JSON.stringify(params.variant_a),
      JSON.stringify(params.variant_b),
      params.metric ?? 'success_rate',
    ]);
    return rows[0];
  }

  async list(status?: string): Promise<Experiment[]> {
    const { rows } = await pool.query<Experiment>(`
      SELECT id, name, description, intent, variant_a, variant_b, metric, status, winner, results, created_at, updated_at FROM agent_experiments
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at DESC
      LIMIT 50
    `, [status ?? null]);
    return rows;
  }

  async getById(id: string): Promise<Experiment | null> {
    const { rows } = await pool.query<Experiment>(
      `SELECT id, name, description, intent, variant_a, variant_b, metric, status,
              winner, results, created_at, updated_at
       FROM agent_experiments WHERE id = $1`,
      [id]
    );
    return rows[0] ?? null;
  }

  async updateStatus(id: string, status: 'running' | 'paused' | 'completed', winner?: 'a' | 'b' | 'tie'): Promise<void> {
    await pool.query(`
      UPDATE agent_experiments
      SET status = $2, winner = $3, updated_at = NOW()
      WHERE id = $1
    `, [id, status, winner ?? null]);
  }

  /**
   * Несмещённый 50/50 split.
   * Раньше использовалось `getSeconds() % 2` — это коррелирует со временем запуска
   * (cron, стартующий в :00, всегда получал вариант 'a') и ломало A/B-баланс.
   * Теперь: если передан стабильный ключ (например, chatId/userId) — детерминированно
   * хэшируем его (один и тот же субъект всегда в одном варианте); иначе — случайно.
   */
  pickVariant(experimentId: string, key?: string | number): 'a' | 'b' {
    if (key === undefined || key === null) {
      return Math.random() < 0.5 ? 'a' : 'b';
    }
    const seed = `${experimentId}:${key}`;
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
    return (h & 1) === 0 ? 'a' : 'b';
  }

  async recordResult(
    experimentId: string,
    variant: 'a' | 'b',
    outcome: 'success' | 'fail',
    durationMs?: number
  ): Promise<void> {
    await pool.query(`
      INSERT INTO ai_actions_log (action_type, metadata)
      VALUES ('agent_experiment_result', $1)
    `, [JSON.stringify({ experiment_id: experimentId, variant, outcome, duration_ms: durationMs })]);
  }

  async findOrCreate(params: CreateExperimentParams): Promise<Experiment> {
    const { rows } = await pool.query<Experiment>(
      `SELECT id, name, description, intent, variant_a, variant_b, metric, status,
              winner, results, created_at, updated_at
       FROM agent_experiments WHERE name = $1 AND status = 'running' LIMIT 1`,
      [params.name]
    );
    if (rows[0]) return rows[0];
    return this.create(params);
  }

  async calculateResults(experimentId: string): Promise<ExperimentResults> {
    const { rows } = await pool.query<ResultRow>(`
      SELECT
        metadata->>'variant' AS variant,
        metadata->>'outcome' AS outcome,
        COUNT(*)::text       AS count
      FROM ai_actions_log
      WHERE action_type = 'agent_experiment_result'
        AND metadata->>'experiment_id' = $1
      GROUP BY metadata->>'variant', metadata->>'outcome'
    `, [experimentId]);

    const counts = { a: { success: 0, fail: 0 }, b: { success: 0, fail: 0 } };
    for (const r of rows) {
      const v = r.variant as 'a' | 'b';
      const o = r.outcome as 'success' | 'fail';
      if ((v === 'a' || v === 'b') && (o === 'success' || o === 'fail')) {
        counts[v][o] = parseInt(r.count, 10);
      }
    }

    const totalA = counts.a.success + counts.a.fail;
    const totalB = counts.b.success + counts.b.fail;
    const rateA  = totalA > 0 ? counts.a.success / totalA : 0;
    const rateB  = totalB > 0 ? counts.b.success / totalB : 0;

    const ciA = wilsonInterval(counts.a.success, totalA);
    const ciB = wilsonInterval(counts.b.success, totalB);

    // Победителя объявляем только если 95% Wilson-интервалы НЕ пересекаются
    // (Roitman §14.4.5: «модели с пересекающимися ДИ статистически неразличимы»).
    let winner: 'a' | 'b' | 'tie' | null = null;
    if (totalA >= 10 && totalB >= 10) {
      if (ciA.low > ciB.high) winner = 'a';
      else if (ciB.low > ciA.high) winner = 'b';
      else winner = 'tie';
    }

    return {
      variant_a: { success: counts.a.success, fail: counts.a.fail, rate: rateA, ci: ciA },
      variant_b: { success: counts.b.success, fail: counts.b.fail, rate: rateB, ci: ciB },
      winner,
      total:     totalA + totalB,
    };
  }
}
