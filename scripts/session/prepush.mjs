#!/usr/bin/env node
/**
 * Проверки перед пушем — одной командой, по строке на шаг (pr-drive §1).
 * Полный вывод каждого шага — в лог; в консоль — итог и путь к логу.
 *
 * Зачем скриптом: проверки перед пушем каждая сессия собирала заново, по
 * вызову модели на шаг и с полным выводом в контексте (статья arXiv
 * 2611.10022: механика — программой, модель — для суждения; слово владельца
 * 20.11 «делай а то очень быстро тает лимит»).
 *
 *   node scripts/session/prepush.mjs [--base origin/main] [--plan]
 *
 * Шаги по изменённым файлам (ветка против базы, индекс, рабочее дерево, новые):
 *  tsc — если тронут TypeScript; eslint — по изменённым файлам кода;
 *  vitest — изменённые тесты и тесты, зависящие от изменённых файлов;
 *  защищённые зоны и номера миграций — строкой сведений, без команды.
 * Тесты на настоящей базе (*.pg.test.ts) идут, только если задан
 * KERNEL_PG_TEST_URL; иначе сказано, что не прогнаны.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zonesOfFile } from '../protected-zones.mjs';

const CODE = /\.(ts|tsx|js|mjs|cjs)$/;
const TS = /\.(ts|tsx)$/;
const UNIT_TEST = /^tests\/unit\/.+\.test\.(ts|tsx)$/;
const PG_TEST = /^tests\/integration\/.+\.pg\.test\.ts$/;
const SOURCE_DIRS = /^(lib|app|components|hooks|scripts)\//;

/** Номер миграции из имени файла; не миграция — null. */
function migrationNumber(file) {
  const m = /^migrations\/(\d+)_[^/]+\.sql$/.exec(file);
  return m ? Number(m[1]) : null;
}

/**
 * План проверок по списку изменённых файлов. Чистая функция: `existing` —
 * номера миграций в базе, `hasPg` — задан ли адрес тестовой базы.
 */
export function planFor(changed, { existing = [], hasPg = false } = {}) {
  const files = [...new Set(changed)].sort();
  const steps = [];
  const notes = [];
  if (files.some((f) => TS.test(f))) steps.push({ name: 'tsc', cmd: ['npx', 'tsc', '--noEmit', '-p', '.'] });
  const lint = files.filter((f) => CODE.test(f));
  if (lint.length > 0) steps.push({ name: 'eslint', cmd: ['npx', 'eslint', ...lint] });
  const unit = files.filter((f) => UNIT_TEST.test(f));
  if (unit.length > 0) steps.push({ name: 'тесты изменённые', cmd: ['npx', 'vitest', 'run', ...unit] });
  const sources = files.filter((f) => SOURCE_DIRS.test(f) && CODE.test(f) && !/\.test\./.test(f));
  if (sources.length > 0) steps.push({ name: 'тесты зависимые', cmd: ['npx', 'vitest', 'related', '--run', ...sources] });
  const pg = files.filter((f) => PG_TEST.test(f));
  if (pg.length > 0) {
    if (hasPg) steps.push({ name: 'тесты на базе', cmd: ['npx', 'vitest', 'run', ...pg] });
    else notes.push(`тесты на базе не прогнаны (нет KERNEL_PG_TEST_URL): ${pg.join(', ')}`);
  }
  const zoned = files.flatMap((f) => zonesOfFile(f).map((z) => `${f} → ${z.id}`));
  notes.push(zoned.length > 0
    ? `защищённые зоны: ${zoned.join('; ')} — в PR нужен раздел «## Слово владельца»`
    : 'защищённых зон нет');
  const mine = files.map(migrationNumber).filter((n) => n !== null);
  const taken = new Set(existing);
  const clash = mine.filter((n) => taken.has(n));
  if (mine.length > 0) {
    const max = existing.length > 0 ? Math.max(...existing) : 0;
    notes.push(clash.length > 0
      ? `миграции: номер ${clash.join(', ')} уже есть в базе — перенумеровать (свободный ${max + 1})`
      : `миграции: ${mine.join(', ')}, в базе последняя ${max}`);
  }
  return { files, steps, notes };
}

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

function changedFiles(base) {
  const all = [
    ...git(['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`]),
    ...git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']),
    ...git(['ls-files', '--others', '--exclude-standard']),
  ];
  return [...new Set(all)].filter((f) => existsSync(f));
}

function baseMigrations(base) {
  return git(['ls-tree', '--name-only', base, 'migrations/'])
    .map(migrationNumber).filter((n) => n !== null);
}

function main() {
  const args = process.argv.slice(2);
  const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'origin/main';
  const plan = planFor(changedFiles(base), {
    existing: baseMigrations(base),
    hasPg: Boolean(process.env.KERNEL_PG_TEST_URL),
  });
  console.log(`изменено файлов: ${plan.files.length}`);
  if (args.includes('--plan')) {
    for (const s of plan.steps) console.log(`план  ${s.name}: ${s.cmd.join(' ')}`);
    for (const n of plan.notes) console.log(`·     ${n}`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'prepush-'));
  let failed = 0;
  plan.steps.forEach((s, i) => {
    const t0 = Date.now();
    const r = spawnSync(s.cmd[0], s.cmd.slice(1), { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const log = join(dir, `${i + 1}.log`);
    writeFileSync(log, out);
    const tests = /Tests\s+([^\n]+)/.exec(out)?.[1]?.trim();
    const sec = Math.round((Date.now() - t0) / 1000);
    if (r.status === 0) console.log(`OK    ${s.name} (${sec} с)${tests ? ` — ${tests}` : ''}`);
    else { failed += 1; console.log(`FAIL  ${s.name} (${sec} с)${tests ? ` — ${tests}` : ''} — лог ${log}`); }
  });
  for (const n of plan.notes) console.log(`·     ${n}`);
  if (plan.steps.length === 0) console.log('·     проверять нечего: кода не тронуто');
  console.log(failed > 0 ? `итог: ${failed} шаг(ов) красные` : 'итог: всё зелёное');
  process.exit(failed > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
