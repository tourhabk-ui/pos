#!/usr/bin/env node
/**
 * Манифест файлов репозитория для Scout-Innovator.
 *
 * На проде образ standalone: исходников app/ и lib/ в нём нет, и сканер
 * файлов агента возвращал пусто. Модель не видела реальной структуры и
 * выдумывала пути (/api/map/pack, schema-usage.ts — issues #2898/#2904).
 * Сборка пишет список путей сюда, Dockerfile копирует его в образ, а
 * lib/agents/scout-path-guard.ts сверяет с ним каждое предложение.
 */
const { readdirSync, writeFileSync } = require('fs');
const { join, relative } = require('path');

const ROOT = process.cwd();
const DIRS = ['app', 'lib', 'components', 'migrations', 'scripts', 'hooks'];
const SKIP = new Set(['node_modules', '.next', '.git']);
const files = [];

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(tsx?|jsx?|mjs|sql)$/.test(e.name)) files.push(relative(ROOT, full).split('\\').join('/'));
  }
}
for (const d of DIRS) walk(join(ROOT, d));
files.sort();
writeFileSync(join(ROOT, 'repo-manifest.json'), JSON.stringify({ generated_at: new Date().toISOString(), files }));
console.log(`repo-manifest.json: ${files.length} files`);
