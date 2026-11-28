/**
 * Еженедельный отчёт Яндекс Вебмастера и Метрики с раннера GitHub — только чтение (27.11).
 *
 * Зовётся из .github/workflows/yandex-seo-report.yml. Токен — только из
 * секрета YANDEX_WEBMASTER_TOKEN; значение в журнал и в артефакт не пишется.
 *
 *   npx tsx scripts/yandex-seo-report.ts <каталог-отчёта>
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kamchatkaToday } from '@/lib/planner/calendar-days';
import { withGatewayRetry, sleep } from '@/lib/seo/webmaster-submit';
import {
  collectYandexSeoReport,
  renderReportMarkdown,
  reportOutcome,
  scrubToken,
  readToken,
  type Fetcher,
} from '@/lib/seo/yandex-seo-report';

async function main(): Promise<number> {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('::error::нужен каталог для report.json и report.md');
    return 1;
  }

  const fetcher: Fetcher = withGatewayRetry<Parameters<Fetcher>[1], Awaited<ReturnType<Fetcher>>>(
    (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }),
    sleep,
  );

  const token = readToken(process.env).token;
  const report = scrubToken(
    await collectYandexSeoReport({ env: process.env, fetcher, today: kamchatkaToday() }),
    token,
  );

  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, 'report.json');
  const mdPath = join(outDir, 'report.md');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, renderReportMarkdown(report));

  const outcome = reportOutcome(report);
  const digest = [
    `## Еженедельный отчёт Вебмастера и Метрики`,
    '',
    `Исход: ${outcome.level} — ${outcome.message}`,
    '',
    `Файлы: \`${jsonPath}\`, \`${mdPath}\`.`,
  ].join('\n');
  console.log(digest);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${digest}\n`);

  if (outcome.level === 'error') {
    console.log(`::error::${outcome.message}`);
    return 1;
  }
  if (outcome.level === 'warning') console.log(`::warning::${outcome.message}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error('::error::отчёт Вебмастера и Метрики упал:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
