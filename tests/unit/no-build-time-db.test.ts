/**
 * Страница, которую Next собирает на сборке, не читает базу.
 *
 * Сборка Docker на Timeweb идёт без DATABASE_URL (в неё проходят только
 * объявленные ARG). Страница без динамического сегмента (или с
 * generateStaticParams), которая на сервере читает базу и не зовёт ничего
 * «запросного» (searchParams, cookies/headers, connection), пререндерится
 * там и отдаёт запечённый отказ до следующей сборки. Ошибка в логе сборки
 * есть, на проде — нет: ответ берётся из кэша.
 *
 * Класс находился трижды по одному: sitemap (#1053, 0 туров), /svodka (#2119,
 * «обстановку получить не удалось»), и аудит 01.10 — сразу пять: /guides
 * («Не удалось загрузить реестр гидов»), /faq («Вопросов пока нет» при 30
 * вопросах), /about и /operators/join (без цифр), карточки рыб (без туров).
 *
 * `revalidate = N` от этого НЕ спасает: первая версия всё равно собирается
 * на сборке, и /about с revalidate = 3600 отдавал страницу без цифр до первой
 * перегенерации. Принимается только force-dynamic или запросный API.
 *
 * Перепись статическая, а не по `next build`: граф импортов страницы и её
 * layout'ов на сервере, до границы 'use client'. Сверено с таблицей маршрутов
 * пробной сборки без базы 01.10: перепись дала ровно те пять страниц, что
 * сборка пометила ○/● и что писали в лог отказ базы.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = process.cwd();
const APP = join(ROOT, 'app');

/** Модули, импорт которых означает чтение базы на сервере. */
const DB_SPECIFIERS = new Set(['pg', '@/lib/db-pool', '@/lib/database', '@/lib/db']);
const DB_FILES = new Set(
  ['lib/db-pool.ts', 'lib/database.ts', 'lib/db.ts'].map((f) => join(ROOT, f)),
);

const EXTS = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js'];

function resolveSpec(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null;
  for (const e of EXTS) {
    const p = base + e;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

function isClient(src: string): boolean {
  return /^\s*(['"])use client\1/.test(src);
}

/** Без комментариев: упоминание в тексте не равно вызову. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const IMPORT_RE =
  /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

const memo = new Map<string, string[] | null>();

/** Цепочка импортов до модуля базы или null. Граница — 'use client'. */
function dbChain(file: string, stack: Set<string> = new Set()): string[] | null {
  if (memo.has(file)) return memo.get(file)!;
  if (stack.has(file)) return null;
  stack.add(file);
  const src = readFileSync(file, 'utf-8');
  let found: string[] | null = null;
  if (!isClient(src)) {
    for (const m of code(src).matchAll(IMPORT_RE)) {
      if (m[2]) continue; // import type — в рантайм не попадает
      const spec = m[3] ?? m[4];
      if (!spec) continue;
      if (DB_SPECIFIERS.has(spec) || spec.startsWith('@/lib/database/')) {
        found = [file];
        break;
      }
      const target = resolveSpec(spec, file);
      if (!target) continue;
      if (DB_FILES.has(target)) {
        found = [file];
        break;
      }
      const sub = dbChain(target, stack);
      if (sub) {
        found = [file, ...sub];
        break;
      }
    }
  }
  stack.delete(file);
  memo.set(file, found);
  return found;
}

function pages(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) pages(p, acc);
    else if (name === 'page.tsx' || name === 'page.ts') acc.push(p);
  }
  return acc;
}

/** Layout'ы над страницей — они рендерятся в её пререндере. */
function layoutsAbove(page: string): string[] {
  const out: string[] = [];
  let d = dirname(page);
  for (;;) {
    for (const f of ['layout.tsx', 'layout.ts']) {
      const p = join(d, f);
      if (existsSync(p)) out.push(p);
    }
    if (d === APP) break;
    d = dirname(d);
  }
  return out;
}

const FORCE_DYNAMIC = /export const dynamic\s*=\s*['"]force-dynamic['"]/;
const GSP = /export\s+(async\s+)?function\s+generateStaticParams|export\s+const\s+generateStaticParams/;
/** Запросный API делает страницу динамической и без объявления. */
const REQUEST_API = /\bsearchParams\b|from\s+['"]next\/headers['"]|\bconnection\(\)|unstable_noStore|\bnoStore\(\)/;

function violations(): string[] {
  const bad: string[] = [];
  for (const page of pages(APP)) {
    const src = readFileSync(page, 'utf-8');
    if (isClient(src)) continue;
    const c = code(src);
    const rel = relative(APP, page);
    const prerenderable = !rel.includes('[') || GSP.test(c);
    if (!prerenderable) continue;
    if (FORCE_DYNAMIC.test(c) || REQUEST_API.test(c)) continue;
    for (const f of [page, ...layoutsAbove(page)]) {
      const chain = dbChain(f);
      if (chain) {
        bad.push(`app/${rel}: ${chain.map((x) => relative(ROOT, x)).join(' -> ')}`);
        break;
      }
    }
  }
  return bad;
}

describe('страницы, собираемые на сборке, не читают базу', () => {
  it('у каждой такой страницы — force-dynamic или запросный API', () => {
    expect(violations()).toEqual([]);
  });

  it('пять страниц аудита 01.10 рендерятся на запросе', () => {
    for (const f of [
      'app/guides/page.tsx',
      'app/faq/page.tsx',
      'app/about/page.tsx',
      'app/operators/join/page.tsx',
      'app/fish/[id]/page.tsx',
    ]) {
      expect(readFileSync(join(ROOT, f), 'utf-8'), f).toMatch(FORCE_DYNAMIC);
    }
  });

  it('перепись видит базу через сервисы, а не только прямой импорт', () => {
    // /about читает базу через lib/stats/platform-counts — прямого импорта нет.
    const chain = dbChain(join(ROOT, 'app/about/page.tsx'));
    expect(chain?.map((x) => relative(ROOT, x))).toContain('lib/stats/platform-counts.ts');
  });

  it('граница клиента: компонент с use client базу на сервере не читает', () => {
    expect(isClient("'use client';\nimport x from 'y';")).toBe(true);
    expect(isClient("import x from 'y';")).toBe(false);
  });
});
