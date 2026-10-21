/**
 * Последний удачный прогноз — в базе, а не только в памяти процесса
 * (миграция 1305). Нужен, когда Open-Meteo не отвечает сразу после
 * перезапуска: 21.10 три выката подряд стёрли память, и погода пропала везде.
 *
 * Любой отказ базы здесь глушится с записью в лог: запас — удобство, без него
 * остаётся честное «прогноз не получили», а не падение страницы.
 */
import { logSwallowedFailure } from '@/lib/observability/swallowed';

const MAX_AGE_SQL = `NOW() - INTERVAL '24 hours'`;
let lastCleanup = 0;

async function db() {
  const { pool } = await import('@/lib/db-pool');
  return pool;
}

export async function saveLastGood(key: string, result: unknown, fetchedAt: Date): Promise<void> {
  try {
    const pool = await db();
    await pool.query(
      `INSERT INTO weather_forecast_last_good (cache_key, result, fetched_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (cache_key) DO UPDATE SET result = EXCLUDED.result, fetched_at = EXCLUDED.fetched_at`,
      [key, JSON.stringify(result), fetchedAt.toISOString()],
    );
    if (Date.now() - lastCleanup > 60 * 60 * 1000) {
      lastCleanup = Date.now();
      await pool.query(`DELETE FROM weather_forecast_last_good WHERE fetched_at < ${MAX_AGE_SQL}`);
    }
  } catch (err) {
    logSwallowedFailure('weather', 'запас прогноза не записан', err);
  }
}

export async function loadLastGood<T>(key: string): Promise<{ result: T; at: number } | null> {
  try {
    const pool = await db();
    const r = await pool.query<{ result: T; fetched_at: Date | string }>(
      `SELECT result, fetched_at FROM weather_forecast_last_good
        WHERE cache_key = $1 AND fetched_at > ${MAX_AGE_SQL}`,
      [key],
    );
    const row = r.rows[0];
    if (!row) return null;
    const at = new Date(row.fetched_at).getTime();
    return Number.isFinite(at) ? { result: row.result, at } : null;
  } catch (err) {
    logSwallowedFailure('weather', 'запас прогноза не прочитан', err);
    return null;
  }
}
