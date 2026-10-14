/**
 * Полоса прокрутки строки чипов не сдвигает страницу (14.10).
 *
 * Lighthouse мерил на /map CLS 0,16–0,18 пять прогонов подряд. Трасса
 * (прогон 16, #2494) назвала механизм: на 3,1 с контейнер карты съехал
 * с y 133 на 141, одной записью с горизонтальным прыжком чипов. Восемь
 * пикселей — это полоса прокрутки сайта (`::-webkit-scrollbar { height: 8px }`
 * в globals.css): она появлялась у строки чипов, когда с загрузкой мест чипов
 * становилось больше, чем влезает. Свой стиль полосы отключает в Chromium
 * накладные полосы, поэтому место она занимает и на телефоне; замер
 * map-page-check этого не видел, потому что Playwright прячет полосы
 * флагом --hide-scrollbars.
 *
 * Заодно: класс `scrollbar-none` стоял у чипов каталога и маршрутов, но
 * Tailwind 3.4 такого класса не создаёт — полоса под чипами оставалась. Класс,
 * обещающий поведение без источника, — объявление в никуда (CLAUDE.md, 10.09).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...tsxFiles(rel));
    else if (rel.endsWith('.tsx')) out.push(rel);
  }
  return out;
}

describe('прокручиваемые строки без полосы, которая занимает место', () => {
  it('сайт задаёт полосам 8 px, а .scrollbar-hide убирает полосу целиком', () => {
    const css = read('app/globals.css');
    expect(css).toMatch(/::-webkit-scrollbar\s*\{[^}]*height:\s*8px/);
    expect(css).toMatch(/\.scrollbar-hide::-webkit-scrollbar\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.scrollbar-hide\s*\{[^}]*scrollbar-width:\s*none/);
  });

  it('класса scrollbar-none нет нигде: Tailwind 3.4 его не создаёт, и полоса оставалась', () => {
    const offenders = [...tsxFiles('app'), ...tsxFiles('components')].filter((f) => read(f).includes('scrollbar-none'));
    expect(offenders).toEqual([]);
  });

  it('на /map ни одна строка с прокруткой по горизонтали не оставляет полосу', () => {
    const page = read('app/map/_MapPageClient.tsx');
    const rows = [...page.matchAll(/className="([^"]*\boverflow-x-auto\b[^"]*)"/g)].map((m) => m[1]);
    expect(rows.length, 'строки чипов /map не найдены — сторож смотрит не туда').toBeGreaterThanOrEqual(2);
    expect(rows.filter((c) => !c.split(/\s+/).includes('scrollbar-hide'))).toEqual([]);
  });
});
