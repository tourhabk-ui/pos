#!/usr/bin/env node
/**
 * KamchatourHub — code audit script
 * Checks for CLAUDE.md violations: any types, console.log, SELECT *, FROM bookings/tours, hex colors, design anti-patterns.
 *
 * Usage:
 *   node audit.mjs                        → scan all app/lib/components (full audit)
 *   node audit.mjs --staged               → scan only git-staged .ts/.tsx files
 *   node audit.mjs --files f1.ts f2.tsx   → scan explicit file list
 *   node audit.mjs --report-only          → always exit 0 (combine with any mode for non-blocking CI)
 *
 * Exit codes:
 *   0  — no critical violations (or --report-only)
 *   1  — critical violations found
 *   2  — bad arguments
 */

import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

// --- Argument parsing ---
const argv = process.argv.slice(2);
const REPORT_ONLY = argv.includes('--report-only');
const STAGED_MODE = argv.includes('--staged');
const FILES_IDX = argv.indexOf('--files');
const FILES_MODE = FILES_IDX !== -1;

// Validate: unknown flags
const knownFlags = new Set(['--report-only', '--staged', '--files']);
for (const arg of argv) {
  if (arg.startsWith('--') && !knownFlags.has(arg)) {
    console.error(`Ошибка: неизвестный флаг "${arg}"`);
    console.error('Использование: node audit.mjs [--staged] [--files f1 f2 ...] [--report-only]');
    process.exit(2);
  }
}
if (STAGED_MODE && FILES_MODE) {
  console.error('Ошибка: --staged и --files нельзя использовать вместе');
  process.exit(2);
}

// --- File resolution ---
async function walkFiles(dir, exts) {
  const results = [];
  async function walk(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '.next') continue;
      const full = join(current, e.name);
      if (e.isDirectory()) await walk(full);
      else if (exts.some(ext => e.name.endsWith(ext))) results.push(full);
    }
  }
  await walk(join(ROOT, dir));
  return results;
}

function getStagedFiles() {
  try {
    const out = execSync('git diff --cached --name-only --diff-filter=ACMR', {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return out.split('\n')
      .map(f => f.trim())
      .filter(f => f && (f.endsWith('.ts') || f.endsWith('.tsx')))
      .map(f => join(ROOT, f));
  } catch {
    return [];
  }
}

/**
 * Файлы, которые обязаны СОДЕРЖАТЬ запрещённые строки, потому что ищут их:
 * детерминированные объективы эволюции и их тесты. Без исключения аудит
 * клеймит собственных сторожей — ровно та ложь, ради отлова которой они есть.
 */
const PATTERN_HOLDERS = /agents\/evo\/(static-checks|mock-detector|finding-guard|claim-signature)\.ts$/;

// --- Checks definition ---
const checks = [
  {
    name: 'any типы',
    dirs: ['app', 'lib', 'components'],
    exts: ['.ts', '.tsx'],
    // \bas\s+any\b — word boundary before "as" prevents "has any" in comments
    pattern: /:\s*any\b|<any>|\bas\s+any\b/,
    exclude: /\.d\.ts$/,
    severity: 'КРИТИЧНО',
  },
  {
    name: 'console.log',
    dirs: ['app', 'lib', 'components'],
    exts: ['.ts', '.tsx'],
    pattern: /console\.log\(/,
    // migrate.ts is a CLI runner — console.log there is intentional
    exclude: new RegExp(`database\\/migrate\\.ts$|${PATTERN_HOLDERS.source}`),
    severity: 'КРИТИЧНО',
  },
  {
    name: 'SELECT * FROM kamchatka_routes (→ v_kamchatka_routes_api)',
    dirs: ['app', 'lib'],
    exts: ['.ts', '.tsx'],
    pattern: /SELECT\s+\*\s+FROM\s+kamchatka_routes\b/i,
    exclude: /mcp\/dev-tools\//,
    severity: 'КРИТИЧНО',
  },
  {
    name: 'SELECT * (явные колонки предпочтительны)',
    dirs: ['app', 'lib'],
    exts: ['.ts', '.tsx'],
    pattern: /SELECT\s+\*/i,
    severity: 'ПРЕДУПРЕЖДЕНИЕ',
  },
  {
    name: 'FROM bookings (→ operator_bookings)',
    dirs: ['app', 'lib'],
    exts: ['.ts', '.tsx'],
    pattern: /FROM\s+bookings\b/i,
    exclude: new RegExp(`mcp\\/dev-tools\\/|${PATTERN_HOLDERS.source}`),
    severity: 'КРИТИЧНО',
  },
  {
    name: 'FROM tours (→ operator_tours)',
    dirs: ['app', 'lib'],
    exts: ['.ts', '.tsx'],
    pattern: /FROM\s+tours\b/i,
    exclude: new RegExp(`mcp\\/dev-tools\\/|${PATTERN_HOLDERS.source}`),
    severity: 'КРИТИЧНО',
  },
  {
    name: 'import pool from (→ named import)',
    dirs: ['app', 'lib'],
    exts: ['.ts', '.tsx'],
    pattern: /import\s+pool\s+from/,
    exclude: PATTERN_HOLDERS,
    severity: 'КРИТИЧНО',
  },
  {
    name: 'Хардкод hex цвет',
    dirs: ['components', 'app'],
    exts: ['.tsx'],
    pattern: /#[0-9a-fA-F]{3,6}(?![0-9a-fA-F])/,
    severity: 'ПРЕДУПРЕЖДЕНИЕ',
  },
  {
    name: 'backdrop-blur (запрещено)',
    dirs: ['components', 'app'],
    exts: ['.tsx'],
    pattern: /backdrop-blur/,
    severity: 'ПРЕДУПРЕЖДЕНИЕ',
  },
  {
    name: 'rounded-2xl (→ rounded-lg)',
    dirs: ['components', 'app'],
    exts: ['.tsx'],
    pattern: /rounded-2xl/,
    severity: 'ПРЕДУПРЕЖДЕНИЕ',
  },
  {
    name: 'bg-white (→ bg-[var(--bg-card)])',
    dirs: ['components', 'app'],
    exts: ['.tsx'],
    pattern: /\bbg-white\b(?!\/)/,
    severity: 'ПРЕДУПРЕЖДЕНИЕ',
  },
];

// --- Build file list for this run ---
let filesToScan;
let modeLabel;

if (STAGED_MODE) {
  filesToScan = getStagedFiles();
  modeLabel = `staged (${filesToScan.length} файлов)`;
} else if (FILES_MODE) {
  const paths = argv.slice(FILES_IDX + 1).filter(a => !a.startsWith('--'));
  if (paths.length === 0) {
    console.error('Ошибка: --files требует хотя бы один путь к файлу');
    process.exit(2);
  }
  filesToScan = paths.map(p => resolve(ROOT, p));
  modeLabel = `files (${filesToScan.length} файлов)`;
} else {
  filesToScan = null; // full scan — determined per-check by dirs
  modeLabel = 'full';
}

// --- Run checks ---
const findings = { 'КРИТИЧНО': [], 'ПРЕДУПРЕЖДЕНИЕ': [] };
const checkedFiles = new Set();

for (const check of checks) {
  let files;
  if (filesToScan !== null) {
    // Staged/files mode: filter the given list by the check's exts
    // Тот же охват, что при полном скане: проверка смотрит только свои dirs.
    // Иначе staged-режим цеплял tests/ и клеймил тестовые фикстуры, которые
    // намеренно содержат запрещённые строки.
    files = filesToScan.filter(f =>
      check.exts.some(ext => f.endsWith(ext)) &&
      check.dirs.some(dir => f.startsWith(join(ROOT, dir) + sep)) &&
      !(check.exclude && check.exclude.test(f))
    );
  } else {
    // Full scan
    files = [];
    for (const dir of check.dirs) {
      files.push(...await walkFiles(dir, check.exts));
    }
    files = files.filter(f => !(check.exclude && check.exclude.test(f)));
  }

  for (const file of files) {
    let content;
    try { content = await readFile(file, 'utf8'); }
    catch { continue; }
    checkedFiles.add(file);

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      // Skip lines with explicit suppress marker
      if (raw.includes('audit-ignore')) continue;
      // Strip trailing // line-comment before matching to avoid false positives
      // in comments (e.g. "has any" matched by any-type check)
      const stripped = raw.replace(/\/\/.*$/, '');
      if (check.pattern.test(stripped)) {
        findings[check.severity].push({
          file: relative(ROOT, file),
          line: i + 1,
          check: check.name,
          snippet: raw.trim().slice(0, 80),
        });
      }
    }
  }
}

// --- Output ---
const date = new Date().toISOString().slice(0, 10);
console.log(`\nАУДИТ: KamchatourHub [${modeLabel}]\nДата: ${date}\n`);

if (findings['КРИТИЧНО'].length === 0 && findings['ПРЕДУПРЕЖДЕНИЕ'].length === 0) {
  console.log(`✅ 0 нарушений — ${modeLabel === 'full' ? 'всё чисто' : 'staged файлы чисты'}.\n`);
  process.exit(0);
}

if (findings['КРИТИЧНО'].length > 0) {
  console.log(`КРИТИЧНЫЕ (${findings['КРИТИЧНО'].length} нарушений):`);
  for (const f of findings['КРИТИЧНО']) {
    console.log(`  [ ] ${f.file}:${f.line} — ${f.check}`);
    console.log(`      ${f.snippet}`);
  }
  console.log('');
}

if (findings['ПРЕДУПРЕЖДЕНИЕ'].length > 0) {
  console.log(`ПРЕДУПРЕЖДЕНИЯ (${findings['ПРЕДУПРЕЖДЕНИЕ'].length} нарушений):`);
  for (const f of findings['ПРЕДУПРЕЖДЕНИЕ']) {
    console.log(`  [ ] ${f.file}:${f.line} — ${f.check}`);
  }
  console.log('');
}

const total = findings['КРИТИЧНО'].length + findings['ПРЕДУПРЕЖДЕНИЕ'].length;
console.log(`ИТОГО: ${total} нарушений (критичных: ${findings['КРИТИЧНО'].length}, предупреждений: ${findings['ПРЕДУПРЕЖДЕНИЕ'].length})`);
console.log(`Проверено файлов: ${checkedFiles.size}\n`);

if (findings['КРИТИЧНО'].length > 0 && !REPORT_ONLY) process.exit(1);
