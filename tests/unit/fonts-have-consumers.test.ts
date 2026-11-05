/**
 * Шрифт объявлен — значит его кто-то читает (аудит vedarai.ru 01.10), и
 * сборка не ходит за шрифтами в Google (05.11).
 *
 * Unbounded и Manrope остались в app/layout.tsx от редизайнов v7/v8: их
 * переменные не читал ни один стиль, а preload скачивал четыре их файла на
 * каждой странице. Из 12 предзагрузок треть была мёртвым весом, страница
 * весила 370–474 КБ шрифтов. Объявление без потребителя (CLAUDE.md, правило
 * 10.09) — здесь оно ещё и платное.
 *
 * 05.11: next/font/google скачивал шрифты с Google при каждой сборке, и сбой
 * его сети ронял сборку CI (#3046). Шрифты теперь из пакетов Fontsource
 * (app/layout.tsx), переменные — в globals.css. Preload у Fontsource нет:
 * @font-face без использования браузер не качает, лишнего веса нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const LAYOUT = readFileSync(join(ROOT, 'app/layout.tsx'), 'utf-8');

const GLOBALS = readFileSync(join(ROOT, 'app/globals.css'), 'utf-8');

/** Переменные шрифтов из globals.css: имя и первое семейство Fontsource. */
function fontVars(css: string): Array<{ name: string; family: string }> {
  return [...css.matchAll(/(--font-[\w-]+):\s*'([^']+) Variable'/g)].map((m) => ({ name: m[1], family: m[2] }));
}

/** «Playfair Display» → @fontsource-variable/playfair-display. */
const packageOf = (family: string) => `@fontsource-variable/${family.toLowerCase().replace(/\s+/g, '-')}`;

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

describe('шрифты сайта', () => {
  const vars = fontVars(GLOBALS);

  it('перепись нашла шрифты', () => {
    expect(vars.map((v) => v.name).sort()).toEqual(['--font-jetbrains', '--font-outfit', '--font-playfair']);
  });

  it('у каждой переменной шрифта есть читатель', () => {
    const consumers = CONSUMERS.replace(/(--font-[\w-]+):\s*'[^']+ Variable'/g, '');
    const dead = vars.map((v) => v.name).filter((v) => !consumers.includes(`var(${v}`));
    expect(dead).toEqual([]);
  });

  it('семейство каждой переменной подключено пакетом в layout', () => {
    for (const v of vars) expect(LAYOUT, v.family).toContain(`import '${packageOf(v.family)}/`);
  });

  it('сборка не ходит за шрифтами в Google', () => {
    expect(LAYOUT).not.toMatch(/from 'next\/font\/google'/);
    expect(GLOBALS).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  it('снятых семейств нет', () => {
    expect(LAYOUT).not.toMatch(/\bUnbounded\b|\bManrope\b/);
  });
});
