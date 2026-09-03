/**
 * Радар различает вулкан и сейсмособытие формой, не только цветом.
 *
 * ── Случай 03.09 ───────────────────────────────────────────────────────────
 *
 * Владелец: «в радаре нужно отличать вулкан от сейсмособытий». До этого оба
 * рисовались одинаковым кружком, а цвет кодировал только СИЛУ (критично /
 * опасно / внимание), не РОД опасности — различить вулкан и землетрясение
 * рядом на круге можно было только тапом по каждой точке по очереди.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const LIVE = strip(read('components/safety/LiveStatus.tsx'));
const at = LIVE.indexOf('export function RadarScope');
const comp = LIVE.slice(at, at + 12000);

describe('форма точки зависит от рода, не только цвет — от силы', () => {
  it('вулкан рисуется треугольником (polygon), не кругом', () => {
    const markAt = comp.indexOf("h.kind === 'volcano' ?");
    expect(markAt, 'ветка по kind не найдена').toBeGreaterThan(0);
    const block = comp.slice(markAt, markAt + 500);
    expect(block).toMatch(/<polygon/);
  });

  it('всё остальное — по-прежнему круг', () => {
    const markAt = comp.indexOf("h.kind === 'volcano' ?");
    const block = comp.slice(markAt, markAt + 500);
    expect(block).toMatch(/<circle/);
  });

  it('цвет по-прежнему кодирует силу — LEVEL_COLOR используется и в треугольнике, и в круге', () => {
    const markAt = comp.indexOf("h.kind === 'volcano' ?");
    const block = comp.slice(markAt, markAt + 500);
    const matches = block.match(/LEVEL_COLOR\[h\.level\]/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('легенда формы — только когда есть что различать', () => {
  it('строка легенды условна: и вулкан, и не-вулкан должны быть на круге', () => {
    const legAt = comp.indexOf('rshapes');
    expect(legAt, 'легенда формы не найдена').toBeGreaterThan(0);
    const before = comp.slice(Math.max(0, legAt - 400), legAt);
    expect(before).toMatch(/placed\.some\(\(h\) => h\.kind === 'volcano'\)/);
    expect(before).toMatch(/placed\.some\(\(h\) => h\.kind !== 'volcano'\)/);
  });

  it('легенда объясняет обе формы словами', () => {
    const legAt = comp.indexOf('<div className="rshapes">');
    const block = comp.slice(legAt, legAt + 500);
    expect(block).toMatch(/вулкан/);
    expect(block).toMatch(/сейсмика/);
  });
});
