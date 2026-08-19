/**
 * scripts/census-verdict.ts
 *
 * Судит перепись, снятую с прода, по порогам из репозитория.
 * Возврат 1 при выходе за порог: прогон обязан краснеть, иначе находка
 * останется строкой в логе, которую никто не читает.
 *
 * Использование: census-verdict.ts <перепись.json> <вердикт.md>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { judgeCensus, renderCensusVerdict } from '@/lib/routes/census-verdict';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('Использование: census-verdict.ts <перепись.json> <вердикт.md>');
  process.exit(2);
}

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(inPath, 'utf-8'));
} catch (e) {
  // Нечитаемый ответ прода — это отказ, а не «нарушений не найдено».
  writeFileSync(outPath, `Перепись не состоялась.\n\nОтвет прода не разобрался: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

const audit = raw as Parameters<typeof judgeCensus>[0];
const verdict = judgeCensus(audit);
const md = renderCensusVerdict(verdict);
writeFileSync(outPath, `${md}\n`);
console.log(md);
process.exit(verdict.red ? 1 : 0);
