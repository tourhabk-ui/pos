/**
 * scripts/export-census.ts — перепись механизмов lib/, которых никто не зовёт.
 *
 * Замер, а не чистка: ничего не удаляет и удалять не предлагает. Правило
 * разбора — `lib/quality/export-census.ts`, сторож — `tests/unit/export-census.test.ts`.
 *
 *   npx tsx scripts/export-census.ts            — свод + списки
 *   npx tsx scripts/export-census.ts --json     — то же машиночитаемо
 */
import fs from 'fs';
import path from 'path';
import {
  exportedFunctions, importsOf, classifyExports, summarize, isTestFile,
  type ImportEdge, type ExportRecord,
} from '../lib/quality/export-census';

const ROOT = path.resolve(__dirname, '..');
const SCAN = ['lib', 'app', 'components', 'hooks', 'scripts', 'tests', 'infra'];
const EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git']);

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.includes(path.extname(e.name))) out.push(p);
  }
}

const files: string[] = [];
for (const d of SCAN) walk(path.join(ROOT, d), files);
// Файлы в корне тоже зовут код: `instrumentation.ts` и `middleware.ts` —
// точки входа Next.js, и потребитель, найденный только там, ничем не хуже.
for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (e.isFile() && EXT.includes(path.extname(e.name))) files.push(path.join(ROOT, e.name));
}

const src = new Map<string, string>();
for (const f of files) src.set(path.relative(ROOT, f), fs.readFileSync(f, 'utf8'));

/**
 * `@/x` и относительные пути → путь в репозитории. Пакеты пропускаются.
 *
 * `.js` в спецификаторе снимается: ESM-модули (`lib/mcp/…`) импортируют
 * соседей как `'./sources/mches-telegram.js'`, а на диске лежит `.ts`. Без
 * этого три живых разборщика МЧС, ВК и реестра туробъектов числились
 * сиротами — то есть замер объявлял мёртвым работающий источник данных.
 */
function resolveSpec(fromRel: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = path.normalize(path.join(path.dirname(fromRel), spec));
  else return null;

  const bases = [base];
  const jsExt = /\.(js|mjs|cjs)$/.exec(base);
  if (jsExt) bases.push(base.slice(0, -jsExt[0].length));

  for (const b of bases) {
    for (const e of ['', ...EXT, ...EXT.map((x) => `/index${x}`)]) {
      if (src.has(b + e)) return b + e;
    }
  }
  return null;
}

const declared = new Map<string, string[]>();
for (const [f, s] of src) {
  if (!f.startsWith('lib/') || isTestFile(f)) continue;
  const fns = exportedFunctions(s, f);
  if (fns.length) declared.set(f, fns);
}

const edges: ImportEdge[] = [];
let unresolved = 0;
for (const [f, s] of src) {
  for (const imp of importsOf(s, f)) {
    const to = resolveSpec(f, imp.spec);
    if (!to) {
      if (imp.spec.startsWith('@/') || imp.spec.startsWith('.')) unresolved++;
      continue;
    }
    edges.push({ from: f, to, names: imp.names, reexport: imp.reexport });
  }
}

const records = classifyExports(declared, edges, src);
const sum = summarize(records);

/**
 * Вторая улика для сирот: встречается ли имя ещё где-нибудь в репозитории.
 *
 * Совпадение не означает вызова — это может быть тёзка в другом файле или
 * строка в промпте. Но разница важна: имя, не встречающееся НИГДЕ, кроме
 * своего файла, — это отсутствие потребителя без всяких оговорок.
 */
const entries = [...src.entries()];
function mentionedElsewhere(rec: ExportRecord): string[] {
  const re = new RegExp(`\\b${rec.name}\\b`);
  const hits: string[] = [];
  for (const [f, s] of entries) {
    if (f === rec.file) continue;
    if (re.test(s)) hits.push(f);
    if (hits.length > 3) break;
  }
  return hits;
}

const orphans = records.filter((r) => r.state === 'orphan');
const silent: ExportRecord[] = [];
const namesakes: Array<{ rec: ExportRecord; where: string[] }> = [];
for (const r of orphans) {
  const where = mentionedElsewhere(r);
  if (where.length === 0) silent.push(r); else namesakes.push({ rec: r, where });
}
const testOnly = records.filter((r) => r.state === 'test-only');

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ summary: sum, unresolved, silent, namesakes, testOnly }, null, 2));
} else {
  console.log(`файлов просмотрено: ${src.size}, рёбер импорта: ${edges.length} (неразрешённых: ${unresolved})`);
  console.log(`экспортируемых функций в lib/: ${sum.total}`);
  console.log(`  used      ${sum.used}\t зовут из рабочего кода`);
  console.log(`  internal  ${sum.internal}\t зовёт свой файл; лишнее здесь только слово export`);
  console.log(`  test-only ${sum.testOnly}\t снаружи зовут только тесты, свой файл не зовёт`);
  console.log(`  barrel    ${sum.barrel}\t только переэкспорт, дальше никто не берёт`);
  console.log(`  orphan    ${sum.orphan}\t не зовёт никто и нигде`);
  console.log(`\nСИРОТЫ БЕЗ УПОМИНАНИЙ ВНЕ СВОЕГО ФАЙЛА (${silent.length}):`);
  for (const r of silent) console.log(`  ${r.file}  ${r.name}`);
  console.log(`\nСИРОТЫ-ТЁЗКИ — имя есть ещё где-то, но это другой символ (${namesakes.length}):`);
  for (const n of namesakes) console.log(`  ${n.rec.file}  ${n.rec.name}  ← ${n.where.slice(0, 2).join(', ')}`);
  console.log(`\nTEST-ONLY (${testOnly.length}):`);
  for (const r of testOnly) console.log(`  ${r.file}  ${r.name}`);
}
