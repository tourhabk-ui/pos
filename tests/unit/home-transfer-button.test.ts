// @vitest-environment node
/**
 * Кнопка «Трансфер» на главной (владелец 09.10: «в ленте туров пусть будет
 * трансфер и доп кнопка на главной»). Карточка в ленте (#2305) ведёт к одному
 * перевозчику; кнопка — в раздел /transfers целиком: места в поездках и
 * вахтовка под заказ. Сторож держит, что обе двери на обоих деревьях главной
 * есть, ведут куда обещают и что у цели есть скелет перехода.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');

describe('кнопка «Трансфер» на главной', () => {
  it('телефон: плитка в ряду инструментов, ведёт на /transfers', () => {
    const c = read('app/_home/_HomeV8Client.tsx');
    expect(c).toMatch(/<Link href="\/transfers" className="qt qt-transfer"/);
    // плитка стоит внутри ряда инструментов, а не вне его
    const nav = c.slice(c.indexOf('className="qtools qt-top"'), c.indexOf('</nav>', c.indexOf('className="qtools qt-top"')));
    expect(nav).toContain('qt-transfer');
    expect(nav).toContain('qt-plan');
    expect(nav).toContain('qt-radar');
  });

  it('телефон: «Туры» — кнопкой рядом с «Трансфером», ряд инструментов — сетка 2×2', () => {
    // Владелец 09.10: «туры тогда тоже сделай кнопкой». Четыре плитки — два
    // ряда по две; «Трансфер» больше не растягивается на обе колонки.
    const c = read('app/_home/_HomeV8Client.tsx');
    const nav = c.slice(c.indexOf('className="qtools qt-top"'), c.indexOf('</nav>', c.indexOf('className="qtools qt-top"')));
    expect(nav).toMatch(/<Link href="\/catalog" className="qt qt-tours"/);
    expect(nav.indexOf('qt-tours')).toBeLessThan(nav.indexOf('qt-transfer'));
    expect(c).not.toMatch(/\.v7 \.qt-transfer\{grid-column/);
    // подпись в полширины не длиннее, чем у соседей, — иначе обрежется на 360px
    for (const sub of [...nav.matchAll(/<b>[^<]+<\/b><span>([^<]+)<\/span>/g)].map((m) => m[1]!)) {
      expect(sub.length, sub).toBeLessThanOrEqual(16);
    }
  });

  it('десктоп: ссылка «Трансфер» рядом с «Все туры» в шапке «Можно поехать»', () => {
    const d = read('components/homepage/desk/DeskTours.tsx');
    expect(d).toMatch(/href="\/transfers"[\s\S]{0,260}Трансфер/);
    expect(d).toMatch(/href="\/catalog"/);
  });

  it('у цели есть скелет перехода: страница читает прайс из базы и открывается не мгновенно', () => {
    expect(existsSync(join(process.cwd(), 'app/transfers/loading.tsx'))).toBe(true);
    expect(read('app/transfers/loading.tsx')).toMatch(/RouteLoading/);
  });
});
