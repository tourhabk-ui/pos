#!/usr/bin/env node
/**
 * scripts/update-readme-stats.mjs
 *
 * Держит блок «Масштаб» в README.md честным: считает реальные код-метрики
 * (страницы, API, компоненты, lib, миграции, тесты, workflow) и переписывает
 * содержимое между маркерами <!-- STATS:START --> и <!-- STATS:END -->.
 *
 * Запуск:   node scripts/update-readme-stats.mjs
 * Проверка: node scripts/update-readme-stats.mjs --check   (exit 1, если отстал)
 *
 * Без сети и БД — только счёт файлов. Каталожные цифры (места/маршруты/гиды)
 * живут в БД и в этот блок НЕ входят (их сверяют через админку).
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const ROOT = process.cwd();
const CHECK = process.argv.includes('--check');

/** Рекурсивно собрать файлы под dir, для которых pred(path) === true. */
function walk(dir, pred, acc = []) {
  let entries;
  try { entries = readdirSync(join(ROOT, dir)); } catch { return acc; }
  for (const name of entries) {
    const rel = join(dir, name);
    let st;
    try { st = statSync(join(ROOT, rel)); } catch { continue; }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.next' || name === '.git') continue;
      walk(rel, pred, acc);
    } else if (pred(rel)) {
      acc.push(rel);
    }
  }
  return acc;
}

const pages      = walk('app', p => p.endsWith('page.tsx'));
const apiRoutes  = walk('app/api', p => p.endsWith('route.ts'));
const components = walk('components', p => extname(p) === '.tsx');
const libModules = walk('lib', p => extname(p) === '.ts' && !p.endsWith('.d.ts'));
const testFiles  = walk('tests', p => p.endsWith('.test.ts') || p.endsWith('.test.tsx'));
const workflows  = walk('.github/workflows', p => p.endsWith('.yml') || p.endsWith('.yaml'));

const migrationFiles = walk('migrations', p => p.endsWith('.sql'));
const latestMigration = migrationFiles
  .map(p => parseInt((p.split('/').pop() || '').match(/^(\d+)/)?.[1] ?? '0', 10))
  .reduce((m, n) => Math.max(m, n), 0);

// Статический счёт тест-кейсов: вхождения it(/test( в тест-файлах.
let testCases = 0;
for (const f of testFiles) {
  try {
    const m = readFileSync(join(ROOT, f), 'utf8').match(/\b(?:it|test)\s*\(/g);
    testCases += m ? m.length : 0;
  } catch { /* skip */ }
}

const rows = [
  ['Страниц', pages.length],
  ['API routes', apiRoutes.length],
  ['UI компонентов', components.length],
  ['lib-модулей', libModules.length],
  ['SQL миграций', `${migrationFiles.length} (последняя \`${String(latestMigration).padStart(3, '0')}\`)`],
  ['Юнит-тестов', `${testCases} в ${testFiles.length} файлах`],
  ['GitHub Actions', `${workflows.length} workflow`],
];

const table = [
  '| Метрика | Значение |',
  '|---------|----------|',
  ...rows.map(([k, v]) => `| ${k} | ${v} |`),
].join('\n');

const START = '<!-- STATS:START -->';
const END = '<!-- STATS:END -->';
const readmePath = join(ROOT, 'README.md');
const readme = readFileSync(readmePath, 'utf8');

const re = new RegExp(`${START}[\\s\\S]*?${END}`);
if (!re.test(readme)) {
  console.error('README.md: не найдены маркеры STATS:START/STATS:END');
  process.exit(2);
}

const block = `${START}\n${table}\n${END}`;
const updated = readme.replace(re, block);

if (updated === readme) {
  console.log('README актуален — цифры совпадают.');
  process.exit(0);
}

if (CHECK) {
  console.error('README отстал: цифры «Масштаб» устарели. Запусти: node scripts/update-readme-stats.mjs');
  process.exit(1);
}

writeFileSync(readmePath, updated);
console.log('README обновлён:\n' + table);
