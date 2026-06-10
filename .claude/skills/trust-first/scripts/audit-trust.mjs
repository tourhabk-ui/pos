#!/usr/bin/env node
/**
 * Trust-First audit script — checks for safety anti-patterns.
 * Run: node .claude/skills/trust-first/scripts/audit-trust.mjs
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
    name: 'SOS button calls fetch() without IndexedDB fallback',
    dirs: ['components', 'app'],
    exts: ['.tsx', '.ts'],
    pattern: /sos.*fetch\(|fetch\(.*sos/i,
    antipattern: /indexedDB|idb|localforage|dexie/i,
    message: 'SOS must save to IndexedDB BEFORE network call — works offline',
    severity: 'КРИТИЧНО',
    fileLevel: true,
  },
  {
    name: 'Emergency phone number as plain text (not tel: link)',
    dirs: ['components', 'app'],
    exts: ['.tsx'],
    pattern: /\b112\b|МЧС.*телефон|телефон.*МЧС/,
    antipattern: /href="tel:/,
    message: 'Emergency numbers must be <a href="tel:..."> for mobile tap-to-call',
    severity: 'КРИТИЧНО',
    fileLevel: true,
  },
  {
    name: '"price_from" shown without date/validity',
    dirs: ['components', 'app'],
    exts: ['.tsx'],
    pattern: /price_from|priceFrom|от\s+\d/,
    message: 'Price display — verify it includes last-updated date or validity period',
    severity: 'ПРЕДУПРЕЖДЕНИЕ',
    fileLevel: false,
  },
  {
    name: 'Hardcoded route status "open"/"closed" (should be dynamic)',
    dirs: ['components', 'app'],
    exts: ['.tsx', '.ts'],
    pattern: /"open"|"closed"|'open'|'closed'/,
    message: 'Route open/closed status must come from real-time data, not hardcoded',
    severity: 'ПРЕДУПРЕЖДЕНИЕ',
    fileLevel: false,
  },
  {
    name: 'SELECT * on safety-critical tables',
    dirs: ['app', 'lib'],
    exts: ['.ts'],
    pattern: /SELECT\s+\*.*(?:location_safety|sos|mchs|emergency)/i,
    message: 'SELECT * on safety tables — use explicit columns to prevent data leaks',
    severity: 'КРИТИЧНО',
    fileLevel: false,
  },
  {
    name: 'Missing mchs_registration_required check in route display',
    dirs: ['app/routes', 'app/places'],
    exts: ['.tsx'],
    pattern: /mchs_registration_required|MCHSRegistration/,
    antipattern: /mchs_registration_required/,
    message: 'Route pages should show MChS registration requirement when applicable',
    severity: 'ПРЕДУПРЕЖДЕНИЕ',
    fileLevel: true,
    invertCheck: true,
  },
];

const findings = { 'КРИТИЧНО': [], 'ПРЕДУПРЕЖДЕНИЕ': [] };

for (const check of checks) {
  if (check.fileLevel && check.antipattern && !check.invertCheck) {
    // File-level: flag files that match pattern but lack antipattern (safeguard)
    const files = [];
    for (const dir of check.dirs) {
      files.push(...await walkFiles(dir, check.exts));
    }
    for (const file of files) {
      let content;
      try { content = await readFile(file, 'utf8'); }
      catch { continue; }
      if (check.pattern.test(content) && !check.antipattern.test(content)) {
        findings[check.severity].push({
          file: relative(ROOT, file),
          line: '(file)',
          check: check.name,
          message: check.message,
        });
      }
    }
  } else {
    // Line-level check
    const files = [];
    for (const dir of check.dirs) {
      try { files.push(...await walkFiles(dir, check.exts)); }
      catch { continue; }
    }
    for (const file of files) {
      let content;
      try { content = await readFile(file, 'utf8'); }
      catch { continue; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (check.pattern.test(lines[i])) {
          findings[check.severity].push({
            file: relative(ROOT, file),
            line: i + 1,
            check: check.name,
            message: check.message,
          });
          break; // one finding per file for line-level checks
        }
      }
    }
  }
}

const date = new Date().toISOString().slice(0, 10);
console.log(`\nTRUST AUDIT: KamchatourHub\nДата: ${date}\n`);

if (findings['КРИТИЧНО'].length === 0 && findings['ПРЕДУПРЕЖДЕНИЕ'].length === 0) {
  console.log('✅ Нарушений не найдено — платформа соответствует trust-first стандарту.\n');
  process.exit(0);
}

if (findings['КРИТИЧНО'].length > 0) {
  console.log(`КРИТИЧНЫЕ (${findings['КРИТИЧНО'].length}):`);
  for (const f of findings['КРИТИЧНО']) {
    console.log(`  [ ] ${f.file}:${f.line}`);
    console.log(`      ${f.check}`);
    console.log(`      → ${f.message}`);
  }
  console.log('');
}

if (findings['ПРЕДУПРЕЖДЕНИЕ'].length > 0) {
  console.log(`ПРЕДУПРЕЖДЕНИЯ (${findings['ПРЕДУПРЕЖДЕНИЕ'].length}):`);
  for (const f of findings['ПРЕДУПРЕЖДЕНИЕ']) {
    console.log(`  [ ] ${f.file}:${f.line} — ${f.check}`);
  }
  console.log('');
}

const total = findings['КРИТИЧНО'].length + findings['ПРЕДУПРЕЖДЕНИЕ'].length;
console.log(`ИТОГО: ${total} (критичных: ${findings['КРИТИЧНО'].length})\n`);
if (findings['КРИТИЧНО'].length > 0) process.exit(1);
