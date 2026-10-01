/**
 * Шрифт в layout объявлен — значит его кто-то читает (аудит vedarai.ru 01.10).
 *
 * Unbounded и Manrope остались в app/layout.tsx от редизайнов v7/v8: их
 * переменные не читал ни один стиль, а preload скачивал четыре их файла на
 * каждой странице. Из 12 предзагрузок треть была мёртвым весом, страница
 * весила 370–474 КБ шрифтов. Объявление без потребителя (CLAUDE.md, правило
 * 10.09) — здесь оно ещё и платное.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const LAYOUT = readFileSync(join(ROOT, 'app/layout.tsx'), 'utf-8');

/** Все вызовы next/font в layout: имя функции и тело аргумента. */
function fontCalls(src: string): Array<{ fn: string; body: string }> {
  const out: Array<{ fn: string; body: string }> = [];
  for (const m of src.matchAll(/=\s*([A-Z][A-Za-z_]+)\(\{([\s\S]*?)\}\);/g)) {
    if (/variable:\s*'--font-/.test(m[2])) out.push({ fn: m[1], body: m[2] });
  }
  return out;
}

function sources(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      sources(rel, acc);
    } else if (/\.(tsx?|css)$/.test(e.name)) acc.push(rel);
  }
  return acc;
}

const CONSUMERS = [...sources('app'), ...sources('components'), ...sources('lib')]
  .filter(f => f !== 'app/layout.tsx')
  .map(f => readFileSync(join(ROOT, f), 'utf-8'))
  .join('\n') + readFileSync(join(ROOT, 'tailwind.config.ts'), 'utf-8');

/** Шрифты, которые читает каждая страница: им preload, остальным — нет. */
const PRELOADED = ['--font-playfair', '--font-outfit'];

describe('шрифты layout', () => {
  const calls = fontCalls(LAYOUT);

  it('перепись нашла шрифты', () => {
    expect(calls.length).toBeGreaterThan(0);
  });

  it('у каждой переменной шрифта есть читатель вне layout', () => {
    const dead = calls
      .map(c => c.body.match(/variable:\s*'(--font-[\w-]+)'/)![1])
      .filter(v => !CONSUMERS.includes(`var(${v}`));
    expect(dead).toEqual([]);
  });

  it('preload — только у шрифтов, которые читает каждая страница', () => {
    const preloaded = calls
      .filter(c => !/preload:\s*false/.test(c.body))
      .map(c => c.body.match(/variable:\s*'(--font-[\w-]+)'/)![1])
      .sort();
    expect(preloaded).toEqual([...PRELOADED].sort());
  });

  it('снятых семейств нет', () => {
    expect(LAYOUT).not.toMatch(/\bUnbounded\(|\bManrope\(/);
  });
});
