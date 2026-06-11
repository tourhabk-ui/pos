#!/usr/bin/env node
/**
 * KamchatourHub — runtime project context
 * Counts pages, API routes, components, and migrations from the filesystem.
 * Run once per session: node .claude/skills/kamchatka/scripts/context.mjs
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

async function glob(dir, pattern) {
  const results = [];
  async function walk(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(current, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.match(pattern)) results.push(full);
    }
  }
  await walk(join(ROOT, dir));
  return results;
}

const [pages, routes, components, migrations] = await Promise.all([
  glob('app', /^page\.tsx$/),
  glob('app', /^route\.ts$/),
  glob('components', /\.tsx$/),
  glob('migrations', /\.sql$/),
]);

const table = `
| Метрика | Количество |
|---------|-----------|
| Страницы (page.tsx) | ${pages.length} |
| API routes (route.ts) | ${routes.length} |
| Компоненты (.tsx) | ${components.length} |
| Миграции (.sql) | ${migrations.length} |
`.trim();

console.log('\n=== KamchatourHub — актуальный размер проекта ===\n');
console.log(table);
console.log('\nОбновить CLAUDE.md: замените строку "Масштаб:" на:');
console.log(`Масштаб: ${pages.length} стр / ${routes.length} API routes / ${components.length} компонентов / ${migrations.length} миграций`);

// Patch CLAUDE.md if it contains the old Масштаб line
try {
  const claudeMdPath = join(ROOT, 'CLAUDE.md');
  let content = await readFile(claudeMdPath, 'utf8');
  const newLine = `**Масштаб:** ${pages.length} стр / ${routes.length} API routes / ${components.length} компонентов / ${migrations.length} миграций`;
  const updated = content.replace(/\*\*Масштаб:\*\*[^\n]+|Масштаб: \d+[^\n]+/, newLine);
  if (updated !== content) {
    await writeFile(claudeMdPath, updated, 'utf8');
    console.log('\n✓ CLAUDE.md обновлён автоматически');
  }
} catch {
  // CLAUDE.md not found or not writable — that's fine
}
