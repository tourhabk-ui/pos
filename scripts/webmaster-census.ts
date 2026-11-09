/**
 * Перепись Яндекс Вебмастера с раннера GitHub — только чтение (09.11).
 *
 * Зовётся из .github/workflows/webmaster-census.yml. Окружение для поиска
 * токена собирает `runnerEnv` (lib/seo/webmaster-census-report): секреты по
 * списку имён и переменные репозитория. В журнал и в сводку прогона идёт
 * `censusDigest` — без значений токенов и без чужих сайтов аккаунта.
 *
 *   npx tsx scripts/webmaster-census.ts <маркер.json>
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { webmasterCensus, type Fetcher } from '@/lib/seo/webmaster-census';
import { runnerEnv, censusDigest, censusOutcome } from '@/lib/seo/webmaster-census-report';
import { kamchatkaToday } from '@/lib/planner/calendar-days';

function intField(obj: Record<string, unknown>, key: string, def: number, min: number, max: number): number {
  const v = obj[key];
  const n = typeof v === 'number' ? Math.trunc(v) : def;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

async function main(): Promise<number> {
  const markerPath = process.argv[2];
  let marker: Record<string, unknown> = {};
  if (markerPath) {
    const parsed: unknown = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) marker = parsed as Record<string, unknown>;
  }
  const days = intField(marker, 'days', 90, 7, 365);
  const top = intField(marker, 'top', 100, 10, 500);

  const { env, vars_error } = runnerEnv(process.env, process.env.WM_VARS_JSON);
  if (vars_error) console.log(`::warning::${vars_error} — искали только среди секретов`);

  const fetcher: Fetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const census = await webmasterCensus({ env, fetcher, today: kamchatkaToday(), days, topQueries: top });

  const lines = censusDigest(census, { topQueries: top, examples: 5 });
  const text = lines.join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);

  const outcome = censusOutcome(census);
  if (outcome.level === 'error') {
    console.log(`::error::Перепись Вебмастера не состоялась: ${outcome.message}`);
    return 1;
  }
  if (outcome.level === 'warning') console.log(`::warning::Перепись Вебмастера неполная: ${outcome.message}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error('::error::Перепись Вебмастера упала:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
