/**
 * scripts/modelscope-listing-check.ts — внесены ли мы в каталог MCP ModelScope.
 *
 * Находка аудита 15.10, CN-modelscope. Логика и три исхода — в
 * lib/mcp/modelscope-listing.ts; здесь только запуск с настоящим fetch,
 * сводка job'а и код выхода. Зовёт .github/workflows/modelscope-listing.yml
 * через `npx tsx` без `npm ci`, поэтому импорт относительный, а у модуля
 * импортов нет.
 *
 * Код выхода: 0 — внесены; 1 — нет или не смог (различаются аннотацией:
 * ::error:: «нас нет» против ::warning:: «не смог проверить», §4.0).
 */
import { appendFileSync } from 'node:fs';
import {
  checkModelScopeListing,
  reportModelScopeListing,
  renderModelScopeSummary,
  escapeAnnotation,
} from '../lib/mcp/modelscope-listing';

async function main(): Promise<number> {
  const result = await checkModelScopeListing(fetch);
  const report = reportModelScopeListing(result);
  console.log(JSON.stringify(result, null, 2));
  const summary = renderModelScopeSummary(report);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, summary);
  else console.log(summary);
  console.log(report.annotation);
  return report.exitCode;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    // Упавшая проверка — тоже «не смог», не молчание и не «нас нет».
    const msg = e instanceof Error ? e.stack ?? e.message : String(e);
    console.log(`::warning::${escapeAnnotation(`ModelScope: проверка упала — ${msg}`)}`);
    process.exit(1);
  },
);
