/**
 * Сторож: стили радара не опираются на переменную, которую задаёт кто-то снаружи.
 *
 * Снимок владельца 03.10 (/safety): приписка «Радар видит сейсмику…» и счётчик
 * «43 рядом» — огромным шрифтом. Их правила писались как
 * `font: 400 9px/1.4 var(--fm)`, а `--fm` задавалась только внутри главной
 * (_HomeV8Client). На /safety переменной нет, браузер выбрасывает всё
 * правило `font` целиком, и текст наследует крупный кегль. Так ломались 11
 * правил разом — а на главной компонент выглядел верно, и увидеть поломку
 * можно было только на другой странице.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIVE_STATUS_CSS } from '@/components/safety/LiveStatus';

const ROOT = process.cwd();
const globals = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');
const layout = readFileSync(join(ROOT, 'app/layout.tsx'), 'utf8');
const component = readFileSync(join(ROOT, 'components/safety/LiveStatus.tsx'), 'utf8');

const defined = (name: string) =>
  new RegExp(`${name}\\s*:`).test(LIVE_STATUS_CSS)
  || new RegExp(`${name}\\s*:`).test(globals)
  // Шрифты next/font заводят переменную через `variable: '--font-…'`.
  || layout.includes(`variable: '${name}'`)
  // Переменная, которую компонент ставит инлайн: style={{ '--tk-rows': n }}.
  || component.includes(`'${name}':`);

describe('LiveStatus: все CSS-переменные определены', () => {
  it('ни одной var(--x) без определения в компоненте, globals.css или layout', () => {
    const used = [...new Set([...LIVE_STATUS_CSS.matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1]))];
    expect(used.length).toBeGreaterThan(0);
    const missing = used.filter((v) => !defined(v));
    expect(missing, 'переменные без определения ломают правило целиком').toEqual([]);
  });

  it('--fm задана в самом компоненте, а не берётся с главной', () => {
    expect(LIVE_STATUS_CSS).toMatch(/\.kh-live\{[^}]*--fm:var\(--font-jetbrains\)/);
  });
});
