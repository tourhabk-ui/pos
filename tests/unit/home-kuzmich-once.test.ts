import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Решение владельца 05.09 (скриншот главной): «кузьмич 2 раза — наверху убрать,
// сократить героя, а вниз на навигационную панель поставить иконку с медведем».
// До этого медведь-марка стоял в строке поиска, а сразу под ним в таб-баре —
// портрет Кузьмича: проводник встречал человека дважды на одном экране.
// Судим код, а не прозу: комментарии из исходника вырезаны.

const ROOT = process.cwd();
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const HOME = strip(readFileSync(join(ROOT, 'app/_home/_HomeV8Client.tsx'), 'utf-8'));
const NAV = strip(readFileSync(join(ROOT, 'components/shared/BottomNav.tsx'), 'utf-8'));

describe('Кузьмич на первом экране — один раз', () => {
  it('в строке поиска нет ни медведя, ни портрета', () => {
    const form = HOME.match(/<form className="find"[\s\S]*?<\/form>/)?.[0];
    expect(form, 'форма поиска на месте').toBeDefined();
    expect(form).not.toMatch(/brand\/bear|kuzmich\/portrait|<img/);
    expect(form).toContain('<Search');
  });

  it('медальон таб-бара — медведь из брендового набора', () => {
    const medallion = NAV.match(/href === '\/kuzmich' \?[\s\S]*?<\/span>/)?.[0];
    expect(medallion, 'медальон Кузьмича в таб-баре').toBeDefined();
    expect(medallion).toContain('/images/brand/bear-64.webp');
    expect(medallion).not.toContain('kuzmich/portrait');
  });

  it('портрет остаётся секции «Проводник Кузьмич» — там он говорит', () => {
    expect(HOME).toContain('/images/kuzmich/portrait-192.webp');
  });
});

describe('герой короче', () => {
  it('на телефоне не выше 50dvh — строка поиска и чипы в первом экране', () => {
    const m = HOME.match(/\.v7 \.hero-photo\{[^}]*?min-height:(\d+)vh;min-height:(\d+)dvh/);
    expect(m).not.toBeNull();
    expect(Number(m?.[2])).toBeLessThanOrEqual(50);
    expect(m?.[1]).toBe(m?.[2]);
  });
});
