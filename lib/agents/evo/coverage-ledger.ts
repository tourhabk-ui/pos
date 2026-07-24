/**
 * Леджер покрытия ревью эволюции: чтобы Growth Scan систематически прочёсывал
 * ВСЮ платформу (622 роута / 329 модулей), а не перечитывал одни и те же 2
 * ядровых файла. Каждый прогон помнит, что уже смотрел, и берёт следующие
 * НЕВИДАННЫЕ/давно-невиданные файлы — приоритет по риску пути.
 *
 * Философия: сильная модель (Claude Opus 4.8) бесполезна на 2 чистых файлах.
 * Ценность = широкий обзор × сильный аудитор. Леджер даёт обзор.
 *
 * Селекция — чистая функция (под тестом). БД-слой — тонкая обёртка.
 */
import type { Pool } from 'pg';

export interface LedgerEntry {
  file_path: string;
  last_reviewed_at: string | Date | null;
  review_count: number | null;
  last_findings: number | null;
}

/**
 * Риск пути: чем выше — тем раньше файл попадёт под ревью при первом прочёсе.
 * Платёжки/SOS/брони/auth — критичный контур безопасности и денег.
 */
export function riskScore(path: string): number {
  const p = path.toLowerCase();
  let score = 20; // база (lib-модуль)
  const bump = (re: RegExp, s: number) => { if (re.test(p)) score = Math.max(score, s); };
  bump(/payment|cloudpayments|webhook|tochka|payout|refund|fiscal/, 100);
  bump(/\bsos\b|emergency|safety|rescue|seismic|volcano|mchs/, 95);
  bump(/booking|availability|checkout|reservation|seat|slot/, 85);
  bump(/auth|admin|roles?|permission|token|login|session/, 75);
  bump(/kuzmich|planner|search|lead|operator/, 60);
  bump(/cron/, 45);
  // Внешняя поверхность (HTTP-роут) рискованнее внутренней утилиты.
  if (/^app\/api\/.*route\.ts$/.test(p)) score += 25;
  return score;
}

export interface SelectInput {
  /** Все ревьюибельные пути репозитория. */
  candidates: string[];
  /** Строки леджера (что и когда уже смотрели). */
  ledger: LedgerEntry[];
  /** Недавно изменённые файлы (churn) — всегда в приоритете. */
  recentChanged: string[];
  /** Текущее время (мс) — для тестируемости. */
  now: number;
  /** Сколько файлов взять всего. */
  max: number;
  /** Сколько слотов максимум под churn (остальное — прочёс покрытия). */
  recentCap?: number;
}

/**
 * Выбирает файлы для ревью: сперва недавно изменённые (churn, до recentCap),
 * затем прочёс покрытия — невиданные файлы (по убыванию риска), потом
 * давно-невиданные (по возрастанию времени последнего ревью, тай-брейк риск).
 */
export function selectReviewTargets(input: SelectInput): string[] {
  const { candidates, ledger, recentChanged, now, max } = input;
  const recentCap = input.recentCap ?? Math.max(1, Math.floor(max / 2));
  const candSet = new Set(candidates);
  const byPath = new Map(ledger.map((e) => [e.file_path, e]));
  const result: string[] = [];
  const taken = new Set<string>();

  const push = (f: string) => {
    if (taken.has(f) || !candSet.has(f)) return;
    taken.add(f);
    result.push(f);
  };

  // 1) Churn — недавно изменённые, до recentCap.
  for (const f of recentChanged) {
    if (result.length >= recentCap) break;
    push(f);
  }

  // 2) Прочёс покрытия по оставшимся слотам.
  const lastMs = (e: LedgerEntry | undefined): number => {
    if (!e || !e.last_reviewed_at) return 0; // никогда не смотрели → в самое начало
    const t = new Date(e.last_reviewed_at).getTime();
    return isNaN(t) ? 0 : t;
  };
  const pool = candidates
    .filter((f) => !taken.has(f))
    .sort((a, b) => {
      const la = lastMs(byPath.get(a));
      const lb = lastMs(byPath.get(b));
      if (la !== lb) return la - lb;                 // раньше смотрели / никогда — первыми
      return riskScore(b) - riskScore(a);            // тай-брейк: рискованнее первым
    });

  for (const f of pool) {
    if (result.length >= max) break;
    push(f);
  }

  return result.slice(0, max);
}

// ── DB-слой ──────────────────────────────────────────────────────────────

export async function loadLedger(pool: Pool): Promise<LedgerEntry[]> {
  const { rows } = await pool.query<LedgerEntry>(
    `SELECT file_path, last_reviewed_at, review_count, last_findings FROM evo_review_ledger`,
  );
  return rows;
}

/** Фиксирует, что файлы отревьюены (findings — сколько находок дал каждый). */
export async function recordReviewed(
  pool: Pool,
  findingsByFile: Record<string, number>,
  reviewedFiles: string[],
): Promise<void> {
  for (const f of reviewedFiles) {
    await pool.query(
      `INSERT INTO evo_review_ledger (file_path, last_reviewed_at, review_count, last_findings, updated_at)
       VALUES ($1, NOW(), 1, $2, NOW())
       ON CONFLICT (file_path) DO UPDATE SET
         last_reviewed_at = NOW(),
         review_count = evo_review_ledger.review_count + 1,
         last_findings = $2,
         updated_at = NOW()`,
      [f, findingsByFile[f] ?? 0],
    );
  }
}
