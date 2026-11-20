// @vitest-environment node
/**
 * Клиентский код не дотягивается до базы через цепочку импортов (20.11).
 *
 * PR утверждённых маршрутов парков (#3548) поставил на клиентскую карточку
 * маршрута компонент, который импортировал модуль с `pool` из lib/db-pool:
 * юнит-тесты и tsc были зелёными, а сборка CI упала на «Can't resolve
 * 'util/types'» — `pg` попал в браузерный пакет. Сторожа такой цепочки не
 * было: ловила её только полная сборка.
 *
 * Сторож идёт от каждого файла с 'use client' по импортам (кроме `import
 * type` — они стираются) и требует, чтобы lib/db-pool.ts и lib/database.ts
 * были недостижимы.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = process.cwd();
const SERVER_ONLY = new Set(['lib/db-pool.ts', 'lib/database.ts'].map((p) => join(ROOT, p)));
const DIRS = ['app', 'components', 'lib', 'hooks'];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
}

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null;
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

const IMPORT_RE = /^\s*(import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf-8');
  const out: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    // `import { type A, type B } from` целиком из типов — тоже стирается.
    const stmt = m[0];
    const names = /\{([^}]*)\}/.exec(stmt)?.[1];
    if (names && !/\bfrom\b[^{]*\*/.test(stmt) && names.split(',').map((x) => x.trim()).filter(Boolean).every((x) => x.startsWith('type '))
      && !/^\s*import\s+\w+\s*,/.test(stmt)) continue;
    const r = resolveImport(file, m[2]!);
    if (r) out.push(r);
  }
  return out;
}

describe('клиентский код не тянет базу', () => {
  it('от файлов с «use client» lib/db-pool и lib/database недостижимы', () => {
    const files: string[] = [];
    for (const d of DIRS) if (existsSync(join(ROOT, d))) walk(join(ROOT, d), files);
    const clients = files.filter((f) => /^\s*['"]use client['"]/.test(readFileSync(f, 'utf-8')));
    expect(clients.length).toBeGreaterThan(50);
    const cache = new Map<string, string[]>();
    const bad: string[] = [];
    for (const start of clients) {
      const seen = new Map<string, string | null>([[start, null]]);
      const queue = [start];
      while (queue.length) {
        const f = queue.shift()!;
        if (SERVER_ONLY.has(f)) {
          const chain: string[] = [];
          for (let x: string | null = f; x; x = seen.get(x) ?? null) chain.unshift(relative(ROOT, x));
          bad.push(chain.join(' → '));
          break;
        }
        const next = cache.get(f) ?? importsOf(f);
        cache.set(f, next);
        for (const n of next) if (!seen.has(n)) { seen.set(n, f); queue.push(n); }
      }
    }
    expect(bad, 'клиентский код дотягивается до базы').toEqual([]);
  });
});
