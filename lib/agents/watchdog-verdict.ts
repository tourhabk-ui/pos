/**
 * Итог прогона сторожа для журнала и для второй ноги (GitHub).
 *
 * Аудит агентов 23.11: статус прогона зависел только от упавших проверок.
 * Тревога, которую Telegram не принял, записывалась «успехом» — немой сторож
 * в журнале был зелёным, и заметить это было нечем: за самим сторожем
 * `livenessWatch` не следит («наблюдается в другом месте»), а другого места
 * не было.
 *
 * Теперь недоставка — отказ прогона, и её видит независимый наблюдатель:
 * шаг workflow `cron-watchdog.yml` краснеет и по своему прогону, и по
 * последнему записанному, когда окно занято супервизором
 * (`scripts/watchdog-step.mjs`).
 */
import { pool } from '@/lib/db-pool';
import type { RunStatus } from '@/lib/agents/run-logger';
import type { WatchdogResult } from '@/lib/agents/watchdog';

export interface WatchdogRunVerdict {
  status: RunStatus;
  /** Всё проверено и тревога (если была) дошла. */
  ok: boolean;
  errorsCount: number;
  errorMsg?: string;
  /** Ключ для детектора бесплодных кронов; null — прогон полный. */
  skipReason: string | null;
}

export function watchdogRunVerdict(result: Pick<WatchdogResult, 'checks' | 'delivery'>): WatchdogRunVerdict {
  const failedChecks = result.checks.failed.map((f) => f.check);
  const undelivered = result.delivery.status === 'failed' ? result.delivery.reason : null;

  const parts: string[] = [];
  const skip: string[] = [];
  if (undelivered !== null) {
    parts.push(`тревога не доставлена в Telegram: ${undelivered.slice(0, 200)}`);
    skip.push(`undelivered: ${undelivered.slice(0, 120)}`);
  }
  if (failedChecks.length > 0) {
    parts.push(`не смогли выполниться: ${failedChecks.join(', ')}`);
    skip.push(`unverified: ${failedChecks.join(', ')}`);
  }

  return {
    // Не дошла тревога — прогон не сделал главного, это отказ, а не «частично».
    status: undelivered !== null ? 'failed' : failedChecks.length > 0 ? 'partial' : 'success',
    ok: parts.length === 0,
    errorsCount: failedChecks.length + (undelivered !== null ? 1 : 0),
    errorMsg: parts.length > 0 ? parts.join('; ') : undefined,
    skipReason: skip.length > 0 ? skip.join('; ') : null,
  };
}

/** Последний записанный прогон сторожа — без текста тревог, одни признаки. */
export type LastWatchdogRun =
  | { status: string; age_min: number; delivery: string | null; reason: string | null }
  /** Ни одного прогона в журнале. */
  | { never: true }
  /** Журнал не прочитался — это «не знаю», а не «всё в порядке». */
  | { unread: true };

export async function lastWatchdogRun(): Promise<LastWatchdogRun> {
  try {
    const { rows } = await pool.query<{ status: string; age_min: number; delivery: string | null; reason: string | null }>(
      `SELECT r.status,
              FLOOR(EXTRACT(EPOCH FROM (NOW() - r.ended_at)) / 60)::int AS age_min,
              r.metadata->'delivery'->>'status' AS delivery,
              LEFT(r.metadata->'delivery'->>'reason', 160) AS reason
         FROM agent_run_history r
        WHERE r.agent_id = 'watchdog'
        ORDER BY r.ended_at DESC
        LIMIT 1`,
    );
    return rows[0] ?? { never: true };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : 'нет кода';
    console.error('[watchdog] последний прогон не прочитан, SQLSTATE', code);
    return { unread: true };
  }
}
