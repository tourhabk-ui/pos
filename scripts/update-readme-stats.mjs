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
 * Каталог:  node scripts/update-readme-stats.mjs --catalog /tmp/catalog.json
 *
 * Код-метрики считаются без сети и БД — только по файлам. Каталожные
 * цифры (места/маршруты/гиды) живут в БД и до 04.09 писались в README
 * рукой: с июля стояло «~415 мест, ~421 маршрут» при 379 и 288 по
 * переписям. Теперь их снимает GET /api/cron/catalog-census на проде, а
 * post-merge.yml передаёт ответ сюда через --catalog: блок между
 * CATALOG:START/END переписывается вместе с датой замера. Без --catalog
 * блок не трогается — прежние числа остаются со своей датой, и это честнее
 * нуля. --check каталог не проверяет: у CI нет пути к БД.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const ROOT = process.cwd();
const CHECK = process.argv.includes('--check');
const catalogArg = process.argv.indexOf('--catalog');
const CATALOG_PATH = catalogArg > -1 ? process.argv[catalogArg + 1] : null;

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
let updated = readme.replace(re, block);

/**
 * Блок каталога — из ответа переписи, не из головы. Число null означает
 * «не посчитано» и печатается словами: прежнее значение под новой датой
 * было бы тем самым враньём, ради отлова которого блок и заведён.
 */
export function renderCatalogBlock(census) {
  const day = String(census.measured_at ?? '').slice(0, 10) || 'дата не записана';
  const cell = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : 'не посчитано');
  const rows = [
    ['Мест (`places`)', census.places_living],
    ['Маршрутов (`kamchatka_routes`)', census.routes_living],
    ['Гидов с действующей аттестацией', census.guides_certified],
  ];
  const defs = census.definitions ?? {};
  return [
    `**Каталог** — перепись \`GET /api/cron/catalog-census\` на проде, замер ${day}` +
      ' (обновляется после каждого мержа; «живые» — видимые и не слитые):',
    '',
    '| Сущность | Живых |',
    '|----------|-------|',
    ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`),
    '',
    ...(Object.keys(defs).length
      ? [`<sub>${Object.values(defs).join(' · ')}</sub>`]
      : []),
  ].join('\n');
}

const CAT_START = '<!-- CATALOG:START -->';
const CAT_END = '<!-- CATALOG:END -->';
const catRe = new RegExp(`${CAT_START}[\\s\\S]*?${CAT_END}`);

if (CATALOG_PATH) {
  let census;
  try {
    census = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  } catch (e) {
    console.error(`--catalog: файл ${CATALOG_PATH} не прочитан (${e.message}) — блок каталога не тронут`);
    process.exit(3);
  }
  if (census?.probe !== 'catalog_census_v1') {
    console.error(`--catalog: это не ответ переписи (probe=${census?.probe ?? '—'}) — блок каталога не тронут`);
    process.exit(3);
  }
  if (!catRe.test(updated)) {
    console.error('README.md: не найдены маркеры CATALOG:START/CATALOG:END');
    process.exit(2);
  }
  updated = updated.replace(catRe, `${CAT_START}\n${renderCatalogBlock(census)}\n${CAT_END}`);
}

if (updated === readme) {
  console.log('README актуален — цифры совпадают.');
  process.exit(0);
}

if (CHECK) {
  // Называем расхождение построчно. Сообщение «цифры устарели» без цифр
  // отправляет чинить вслепую: 10.08 гард покраснел в CI и был зелёным
  // локально на том же коммите, и понять причину по логу было нельзя.
  // Сторож, который не говорит, ЧТО разошлось, — сам образец той болезни,
  // которую мы весь день ловим.
  const current = new Map(
    [...(readme.match(re)?.[0] ?? '').matchAll(/^\| ([^|]+?) \| (.+?) \|$/gm)]
      .map((m) => [m[1].trim(), m[2].trim()]),
  );
  console.error('README отстал. Расхождения (в файле → на диске):');
  for (const [k, v] of rows) {
    const was = current.get(k);
    if (was !== String(v)) console.error(`  ${k}: ${was ?? '—'} → ${v}`);
  }
  console.error('Запусти: node scripts/update-readme-stats.mjs');
  process.exit(1);
}

writeFileSync(readmePath, updated);
console.log('README обновлён:\n' + table);
