/**
 * Загрузка в Яндекс Вебмастер с раннера GitHub (11.11): карта сайта и
 * переобход главных страниц. Зовётся из .github/workflows/webmaster-submit.yml;
 * адреса — из маркера, токен — секрет YANDEX_WEBMASTER_TOKEN (значение не
 * печатается). Правила — lib/seo/webmaster-submit.
 *
 *   npx tsx scripts/webmaster-submit.ts <маркер.json>
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { webmasterSubmit, submitDigest, submitOutcome, type WriteFetcher } from '@/lib/seo/webmaster-submit';

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

async function main(): Promise<number> {
  const markerPath = process.argv[2];
  const parsed: unknown = markerPath ? JSON.parse(readFileSync(markerPath, 'utf8')) : {};
  const marker = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};

  const fetcher: WriteFetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const result = await webmasterSubmit({
    token: process.env.YANDEX_WEBMASTER_TOKEN,
    fetcher,
    sitemaps: strings(marker.sitemaps),
    recrawl: strings(marker.recrawl),
  });

  const text = submitDigest(result).join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);

  const outcome = submitOutcome(result);
  if (outcome.level === 'error') {
    console.log(`::error::Загрузка в Вебмастер не состоялась: ${outcome.message}`);
    return 1;
  }
  if (outcome.level === 'warning') console.log(`::warning::Загрузка в Вебмастер неполная: ${outcome.message}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error('::error::Загрузка в Вебмастер упала:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
