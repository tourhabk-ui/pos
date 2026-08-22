/**
 * Клиентский компонент не тянет за собой серверные модули Node.
 *
 * 22.08 сборка на main упала: `Module not found: node:zlib`. Полевая форма
 * (`'use client'`) брала из `lib/field/track-import` одну чистую функцию —
 * расстояние между точками, — но импорт тянет МОДУЛЬ целиком, а модуль
 * распаковывает KMZ через `node:zlib`. Собрать это для браузера webpack не
 * может, и падала не только проверка: деплой собирается тем же build.
 *
 * Отдельно неприятно, что молчали все остальные проверки. `tsc` доволен:
 * типы сходятся, а где выполняется код — не его забота. Тесты доволены:
 * в vitest окружение Node, и `node:zlib` там существует. Ошибка живёт
 * ровно в одном месте — в сборщике, то есть в самом конце.
 *
 * Сторож идёт по локальным импортам вглубь: беда не в прямом соседстве, а
 * в цепочке. `_FieldCheckClient` → `track-import` → `node:zlib` — три звена,
 * и ни одно из них по отдельности не выглядит ошибкой.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const ROOT = process.cwd();

/** Модули Node, которых в браузере нет. Список не полон намеренно: он ловит
 *  форму `node:*`, а она обязательна для встроенных модулей начиная с Node 18. */
const NODE_SCHEME = /from\s+['"]node:([a-z_/]+)['"]/g;

/** Импорты внутри репозитория: `@/...` и относительные. */
const LOCAL_IMPORT = /(?:from|import)\s+['"](@\/[^'"]+|\.\.?\/[^'"]+)['"]/g;

const EXTS = ['.ts', '.tsx', '.js', '.jsx'];

function resolveLocal(spec: string, fromFile: string): string | null {
  const base = spec.startsWith('@/')
    ? join(ROOT, spec.slice(2))
    : resolve(dirname(join(ROOT, fromFile)), spec);
  for (const e of EXTS) if (existsSync(base + e)) return base + e;
  for (const e of EXTS) if (existsSync(join(base, 'index' + e))) return join(base, 'index' + e);
  return null;
}

/** Первая найденная цепочка от файла до модуля Node, либо null. */
function chainToNodeBuiltin(entry: string): string[] | null {
  const seen = new Set<string>();
  const stack: Array<{ file: string; path: string[] }> = [{ file: entry, path: [entry] }];

  while (stack.length) {
    const { file, path } = stack.pop()!;
    const abs = file.startsWith('/') ? file : join(ROOT, file);
    if (seen.has(abs) || !existsSync(abs)) continue;
    seen.add(abs);

    const src = readFileSync(abs, 'utf-8');

    const builtin = [...src.matchAll(NODE_SCHEME)][0];
    if (builtin) return [...path, `node:${builtin[1]}`];

    for (const m of src.matchAll(LOCAL_IMPORT)) {
      const next = resolveLocal(m[1], abs.slice(ROOT.length + 1));
      if (next) stack.push({ file: next, path: [...path, next.slice(ROOT.length + 1)] });
    }
  }
  return null;
}

describe('клиентские компоненты не тянут модули Node', () => {
  it('ни одна цепочка импортов из клиента не доходит до node:*', () => {
    const files = execSync(`git ls-files 'app/**/*.tsx' 'components/**/*.tsx'`, { cwd: ROOT, encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean);

    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf-8');
      // Директива стоит первой строкой файла — иначе это не клиентский компонент.
      if (!/^\s*['"]use client['"]/.test(src)) continue;

      const chain = chainToNodeBuiltin(f);
      if (chain) offenders.push(chain.join(' → '));
    }

    expect(offenders, 'сборка для браузера упадёт на Module not found').toEqual([]);
  });
});
