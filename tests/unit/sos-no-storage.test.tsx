// @vitest-environment jsdom
/**
 * SOS на браузере без хранилища устройства (экран в машине, 21.11).
 *
 * Ловушка ошибок прода за 21.11: «Cannot read properties of null (reading
 * 'getItem')» — у встроенного браузера `window.localStorage` равен null.
 * Меш соседей (`VolcanoMesh`) читал хранилище в конструкторе без проверки, а
 * создаётся он, когда у /sos появились координаты: экран SOS падал в
 * «Произошла ошибка».
 *
 * Сторож держит:
 *   - меш создаётся и шлёт SOS, когда хранилища нет и когда доступ к нему
 *     бросает — вызовом;
 *   - отказ создания меша не роняет хук: статус «error», экран живёт —
 *     рендером хука с подставным мешем;
 *   - окно «Установить приложение» из общего каркаса (оно есть и на /sos)
 *     открывается без хранилища — рендером;
 *   - запрет: в коде, который грузят общий каркас, главная, /sos и экраны
 *     ошибок, каждое обращение к localStorage и sessionStorage стоит внутри
 *     try той же функции — разбором кода (AST), список файлов — по импортам.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import ts from 'typescript';
import { renderHook, render, cleanup } from '@testing-library/react';

const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
function setStorage(desc: PropertyDescriptor) {
  Object.defineProperty(window, 'localStorage', { configurable: true, ...desc });
}
afterEach(() => {
  cleanup();
  if (original) Object.defineProperty(window, 'localStorage', original);
  vi.doUnmock('@/lib/mesh/volcano-mesh');
  vi.resetModules();
});

describe('меш без хранилища устройства', () => {
  it('localStorage равен null — меш создаётся и шлёт SOS', async () => {
    setStorage({ value: null });
    const { VolcanoMesh } = await import('@/lib/mesh/volcano-mesh');
    let mesh: InstanceType<typeof VolcanoMesh> | null = null;
    expect(() => { mesh = new VolcanoMesh(); }).not.toThrow();
    expect(() => mesh!.sendSOS({ lat: 53, lng: 158 } as never)).not.toThrow();
  });

  it('доступ к localStorage бросает — меш создаётся', async () => {
    setStorage({ get() { throw new DOMException('denied', 'SecurityError'); } });
    const { VolcanoMesh } = await import('@/lib/mesh/volcano-mesh');
    expect(() => new VolcanoMesh()).not.toThrow();
  });
});

describe('отказ меша не роняет экран SOS', () => {
  it('конструктор бросил — хук жив, статус «error»', async () => {
    vi.doMock('@/lib/mesh/volcano-mesh', () => ({
      VolcanoMesh: class { constructor() { throw new Error('boom'); } },
    }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { useMesh } = await import('@/hooks/use-mesh');
    const { result } = renderHook(() => useMesh(true, { lat: 53.02, lng: 158.65 }));
    expect(result.current.status).toBe('error');
    expect(err).toHaveBeenCalled();
  });
});

describe('окно «Установить приложение» без хранилища', () => {
  it('localStorage равен null — каркас не падает', async () => {
    setStorage({ value: null });
    vi.doMock('next/navigation', () => ({ usePathname: () => '/sos' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { InstallPrompt } = await import('@/components/PWA/InstallPrompt');
    expect(() => render(<InstallPrompt />)).not.toThrow();
    warn.mockRestore();
    vi.doUnmock('next/navigation');
  });
});

/** Входы: общий каркас, главная, экран SOS и экраны ошибок. */
const ENTRIES = [
  'app/layout.tsx', 'app/page.tsx', 'app/_home/_HomeV8Client.tsx',
  'app/sos/page.tsx', 'app/sos/error.tsx', 'app/sos/relay/page.tsx',
  'app/error.tsx', 'app/global-error.tsx',
];

function resolveImport(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = join(dirname(from), spec);
  else return null;
  for (const ext of ['', '.tsx', '.ts', '/index.tsx', '/index.ts']) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

function reachable(entries: string[]): string[] {
  const seen = new Set<string>();
  const walk = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = readFileSync(f, 'utf8');
    const re = /from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const r = resolveImport(m[1] ?? m[2], f);
      if (r) walk(r);
    }
  };
  entries.forEach(walk);
  return [...seen].sort();
}

/** Обращения к хранилищу вне try своей функции: «файл:строка: код». */
function unguardedStorage(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const inTry = (n: ts.Node): boolean => {
    let c: ts.Node = n;
    while (c.parent) {
      const p = c.parent;
      if (ts.isTryStatement(p) && p.tryBlock === c) return true;
      if (ts.isFunctionLike(p)) return false;
      c = p;
    }
    return false;
  };
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) && ['getItem', 'setItem', 'removeItem', 'clear'].includes(n.name.text)
      && /(^|\.)(localStorage|sessionStorage)\??$/.test(n.expression.getText(sf)) && !inTry(n)) {
      out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${n.parent.getText(sf).slice(0, 80)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('запрет: хранилище без try на пути каркаса, главной и SOS', () => {
  it('входы существуют и тянут сотни файлов', () => {
    for (const e of ENTRIES) expect(existsSync(e), e).toBe(true);
    expect(reachable(ENTRIES).length).toBeGreaterThan(100);
  });

  it('каждое обращение к localStorage и sessionStorage — внутри try своей функции', () => {
    const found = reachable(ENTRIES).flatMap((f) => unguardedStorage(f, readFileSync(f, 'utf8')));
    expect(found).toEqual([]);
  });

  it('разбор узнаёт голый вызов и вызов в колбэке внутри try', () => {
    expect(unguardedStorage('a.ts', "localStorage.getItem('x');")).toHaveLength(1);
    expect(unguardedStorage('a.ts', "window.localStorage?.setItem('x','1');")).toHaveLength(1);
    expect(unguardedStorage('a.ts', "try { setTimeout(() => sessionStorage.getItem('x')); } catch (e) { void e; }")).toHaveLength(1);
    expect(unguardedStorage('a.ts', "try { localStorage.getItem('x'); } catch (e) { void e; }")).toHaveLength(0);
  });
});
