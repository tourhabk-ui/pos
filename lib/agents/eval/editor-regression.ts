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
import { generateRouteDescription, type RouteRow, type EditorPromptVariant } from '@/lib/agents/editor';
import { wilsonInterval, type WilsonInterval } from '@/lib/agents/learning/experiment-tracker';
import { judgeDescription } from '@/lib/agents/eval/editor-judge';
import { detectFabrication } from '@/lib/agents/eval/fabrication';

const GOAL_MIN = 300;       // контракт платформы (CLAUDE.md)
const DEFAULT_LIMIT = 12;

export interface RegressionCase {
  id: string;
  title: string;
  generated_len: number;
  passed: boolean;
  quality_score?: number | null; // 1..5 от LLM-судьи (если включён judge)
  /** Числа, которых не было во входных данных: выдуманная конкретика. */
  invented?: string[];
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
  /** Доля прогонов с выдуманной числовой конкретикой (0..1). */
  fabrication_rate?: number;
  /** Всего выдуманных чисел по всем прогонам. */
  invented_total?: number;
  variant?: EditorPromptVariant;
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

  const withFabrication = cases.filter(c => (c.invented?.length ?? 0) > 0).length;
  report.fabrication_rate = total > 0 ? withFabrication / total : 0;
  report.invented_total = cases.reduce((sum, c) => sum + (c.invented?.length ?? 0), 0);

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

export async function runEditorRegression(opts?: { seedIds?: string[]; limit?: number; judge?: boolean; variant?: EditorPromptVariant }): Promise<RegressionReport> {
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
      text = (await generateRouteDescription(route, opts?.variant ?? 'full')).text; // dry-run, без записи
    } catch {
      text = null;
    }
    const passed = scoreGeneration(text);
    const c: RegressionCase = { id: route.id, title: route.title, generated_len: text?.trim().length ?? 0, passed };
    if (text) {
      // Источник — ровно то, что модели дали на вход.
      const source = `${route.title} ${route.category ?? ''} ${route.description ?? ''}`;
      c.invented = detectFabrication(text, source).invented;
    }
    if (opts?.judge && text) {
      const verdict = await judgeDescription(route, text);
      c.quality_score = verdict.score;
    }
    cases.push(c);
  }

  const report = summarizeRegression(cases);
  report.variant = opts?.variant ?? 'full';
  return report;
}

// ── A/B двух вариантов промпта ───────────────────────────────────────────────

export interface ABVerdict {
  /** Пересекаются ли доверительные интервалы TSR: да — разницы не доказано. */
  tsr_inconclusive: boolean;
  tsr_delta: number;
  fabrication_delta: number;
  verdict: string;
}

/**
 * Сравнение вариантов — чистая функция, под тестом.
 *
 * Правило намеренно консервативное: улучшением считается только то, что
 * выиграло по длине и НЕ проиграло по выдумкам. Рост TSR при росте выдумок —
 * это не улучшение, а более уверенное враньё, и метрика обязана называть его
 * так, иначе замер станет способом доказать себе желаемое.
 */
export function compareVariants(a: RegressionReport, b: RegressionReport): ABVerdict {
  const overlap = a.ci.low <= b.ci.high && b.ci.low <= a.ci.high;
  const tsrDelta = Math.round((b.tsr - a.tsr) * 1000) / 1000;
  const fabDelta = Math.round(((b.fabrication_rate ?? 0) - (a.fabrication_rate ?? 0)) * 1000) / 1000;

  let verdict: string;
  if (fabDelta > 0) {
    verdict = 'вариант B выдумывает чаще — не принимать независимо от TSR';
  } else if (overlap) {
    verdict = 'разница по TSR не доказана (интервалы пересекаются) — нужна выборка больше';
  } else if (tsrDelta > 0) {
    verdict = 'вариант B лучше по TSR и не хуже по выдумкам — можно принимать';
  } else {
    verdict = 'вариант B хуже по TSR — оставить A';
  }

  return { tsr_inconclusive: overlap, tsr_delta: tsrDelta, fabrication_delta: fabDelta, verdict };
}

/** Прогон обоих вариантов по ОДНОМУ И ТОМУ ЖЕ набору входов. */
export async function runEditorAB(opts?: { seedIds?: string[]; limit?: number; judge?: boolean }): Promise<{
  full: RegressionReport;
  lean: RegressionReport;
  comparison: ABVerdict;
}> {
  const full = await runEditorRegression({ ...opts, variant: 'full' });
  const lean = await runEditorRegression({ ...opts, variant: 'lean' });
  return { full, lean, comparison: compareVariants(full, lean) };
}
