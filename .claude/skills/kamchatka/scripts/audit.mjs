#!/usr/bin/env node
/**
 * KamchatourHub — code audit script
 * Checks for CLAUDE.md violations: any types, console.log, SELECT *, FROM bookings/tours, hex colors, design anti-patterns.
 * Run: node .claude/skills/kamchatka/scripts/audit.mjs
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

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

const checks = [
  {
    name: 'any типы',
    dirs: ['app', 'lib', 'components'],
    exts: ['.ts', '.tsx'],
    pattern: /:\s*any\b|<any>|as any\b/,
    exclude: /\.d\.ts$/,
    severity: 'КРИТИЧНО',
  },
  {
    name: 'console.log',
    dirs: ['app', 'lib', 'components'],
    exts: ['.ts', '.tsx'],
    pattern: /console\.log\(/,
    severity: 'КРИТИЧНО',
  },
  {
    name: 'SELECT *',
    dirs: ['app', 'lib'],
    exts: ['.ts', '.tsx'],
    pattern: /SELECT\s+\*/i,
    severity: 'КРИТИЧНО',
  },
  {
    name: 'FROM bookings (→ operator_bookings)',
    dirs: ['app', 'lib'],
    exts: ['.ts', '.tsx'],
    pattern: /FROM\s+bookings\b/i,
    severity: 'КРИТИЧНО',
  },
  {
    name: 'FROM tours (→ operator_tours)',
    dirs: ['app', 'lib'],
    exts: ['.ts', '.tsx'],
    pattern: /FROM\s+tours\b/i,
    severity: 'КРИТИЧНО',
  },
  {
    name: 'import pool from (→ named import)',
    dirs: ['app', 'lib'],
    exts: ['.ts', '.tsx'],
    pattern: /import\s+pool\s+from/,
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

const findings = { 'КРИТИЧНО': [], 'ПРЕДУПРЕЖДЕНИЕ': [] };
let totalChecked = 0;

for (const check of checks) {
  const files = [];
  for (const dir of check.dirs) {
    const found = await walkFiles(dir, check.exts);
    files.push(...found);
  }

  for (const file of files) {
    if (check.exclude && check.exclude.test(file)) continue;
    let content;
    try { content = await readFile(file, 'utf8'); }
    catch { continue; }
    totalChecked++;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (check.pattern.test(lines[i])) {
        findings[check.severity].push({
          file: relative(ROOT, file),
          line: i + 1,
          check: check.name,
          snippet: lines[i].trim().slice(0, 80),
        });
      }
    }
  }
}

const date = new Date().toISOString().slice(0, 10);
console.log(`\nАУДИТ: KamchatourHub\nДата: ${date}\n`);

if (findings['КРИТИЧНО'].length === 0 && findings['ПРЕДУПРЕЖДЕНИЕ'].length === 0) {
  console.log('✅ 0 нарушений — всё чисто.\n');
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
console.log(`Проверено файлов: ${totalChecked}\n`);

if (findings['КРИТИЧНО'].length > 0) process.exit(1);
