/**
 * lib/agents/eval/editor-regression.ts
 *
 * Held-out regression-харнесс для Editor (Roitman §14.8.3 + §20.7.2):
 * прогоняет Editor по ФИКСИРОВАННОМУ набору входов и считает воспроизводимый
 * Task Success Rate (TSR) с доверительным интервалом — чтобы видеть, улучшает
 * или регрессит изменение промпта/модели КАЧЕСТВО, до выкатки в прод.
 *
 * Dry-run: генерация идёт тем же путём, что и у Editor (generateRouteDescription),
 * но БЕЗ записи в БД. Оракул goal-aligned: успех = описание >= контракта (300 симв).
 * TSR оценивается с Wilson-интервалом (переиспользуем из experiment-tracker).
 *
 * Полностью аддитивно: ничего не пишет, ничего существующего не меняет.
 * Для стабильной регрессии передавай фиксированный seedIds (env EDITOR_EVAL_SEED_IDS
 * или параметр); иначе берётся детерминированная выборка (ORDER BY id).
 */

import { pool } from '@/lib/db-pool';
import { generateRouteDescription, type RouteRow } from '@/lib/agents/editor';
import { wilsonInterval, type WilsonInterval } from '@/lib/agents/learning/experiment-tracker';
import { judgeDescription } from '@/lib/agents/eval/editor-judge';

const GOAL_MIN = 300;       // контракт платформы (CLAUDE.md)
const DEFAULT_LIMIT = 12;

export interface RegressionCase {
  id: string;
  title: string;
  generated_len: number;
  passed: boolean;
  quality_score?: number | null; // 1..5 от LLM-судьи (если включён judge)
}

const QUALITY_GOOD_MIN = 4; // балл судьи >= 4 считаем качественным

export interface RegressionReport {
  total: number;
  passed: number;
  tsr: number;            // task success rate (по длине-контракту)
  ci: WilsonInterval;     // 95% Wilson по TSR
  goal_min: number;
  // Качество (если запускали с judge): средний балл и доля «хороших» (>=4)
  judged?: number;
  quality_avg?: number | null;
  quality_good?: number;
  cases: RegressionCase[];
  reason?: string;
}

// ── Чистые помощники (юнит-тестируемые) ──────────────────────────────────────

/** Оракул: успех = сгенерирован текст не короче контракта. */
export function scoreGeneration(text: string | null, minLen = GOAL_MIN): boolean {
  return !!text && text.trim().length >= minLen;
}

/** Сводит результаты в отчёт с TSR, Wilson-интервалом и (если есть) качеством. */
export function summarizeRegression(cases: RegressionCase[], goalMin = GOAL_MIN): RegressionReport {
  const total = cases.length;
  const passed = cases.filter(c => c.passed).length;
  const tsr = total > 0 ? passed / total : 0;
  const report: RegressionReport = { total, passed, tsr, ci: wilsonInterval(passed, total), goal_min: goalMin, cases };

  const scored = cases.map(c => c.quality_score).filter((s): s is number => typeof s === 'number');
  if (scored.length > 0) {
    report.judged = scored.length;
    report.quality_avg = Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 100) / 100;
    report.quality_good = scored.filter(s => s >= QUALITY_GOOD_MIN).length;
  }
  return report;
}

// ── Источник seed-набора ─────────────────────────────────────────────────────

function resolveSeedIds(seedIds?: string[]): string[] {
  if (seedIds && seedIds.length > 0) return seedIds;
  const env = process.env.EDITOR_EVAL_SEED_IDS;
  if (env) return env.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

async function loadSeedRoutes(seedIds: string[], limit: number): Promise<RouteRow[]> {
  if (seedIds.length > 0) {
    const { rows } = await pool.query<RouteRow>(
      `SELECT id, title, description, category
       FROM agent_route_knowledge
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [seedIds],
    );
    return rows;
  }
  // Детерминированная выборка маршрутов, которым нужно описание (стабильна по id)
  const { rows } = await pool.query<RouteRow>(
    `SELECT id, title, description, category
     FROM agent_route_knowledge
     WHERE description IS NULL OR LENGTH(description) < $1
     ORDER BY id
     LIMIT $2`,
    [GOAL_MIN, limit],
  );
  return rows;
}

// ── Оркестратор ──────────────────────────────────────────────────────────────

export async function runEditorRegression(opts?: { seedIds?: string[]; limit?: number; judge?: boolean }): Promise<RegressionReport> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const seedIds = resolveSeedIds(opts?.seedIds);

  let routes: RouteRow[];
  try {
    routes = await loadSeedRoutes(seedIds, limit);
  } catch (e) {
    return { total: 0, passed: 0, tsr: 0, ci: { low: 0, high: 0 }, goal_min: GOAL_MIN, cases: [], reason: `db_error: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (routes.length === 0) {
    return { total: 0, passed: 0, tsr: 0, ci: { low: 0, high: 0 }, goal_min: GOAL_MIN, cases: [], reason: 'no_seed_routes' };
  }

  const cases: RegressionCase[] = [];
  for (const route of routes) {
    let text: string | null = null;
    try {
      text = await generateRouteDescription(route); // dry-run, без записи и без A/B
    } catch {
      text = null;
    }
    const passed = scoreGeneration(text);
    const c: RegressionCase = { id: route.id, title: route.title, generated_len: text?.trim().length ?? 0, passed };
    if (opts?.judge && text) {
      const verdict = await judgeDescription(route, text);
      c.quality_score = verdict.score;
    }
    cases.push(c);
  }

  return summarizeRegression(cases);
}
